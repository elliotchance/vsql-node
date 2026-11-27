'use strict';

const lib = require('./binding');
const { toParams, types } = require('./convert');

// The isolation levels that begin takes.
const isolationLevels = new Map([
  ['READ UNCOMMITTED', lib.SQL_TRANSACTION_READ_UNCOMMITTED],
  ['READ COMMITTED', lib.SQL_TRANSACTION_READ_COMMITTED],
  ['REPEATABLE READ', lib.SQL_TRANSACTION_REPEATABLE_READ],
  ['SERIALIZABLE', lib.SQL_TRANSACTION_SERIALIZABLE],
]);

// The fields of info, and the kind of each for lib.getInfo.
const infoFields = [
  ['dbmsName', lib.SQL_DBMS_NAME, 's'],
  ['dbmsVersion', lib.SQL_DBMS_VERSION, 's'],
  ['buildVersion', lib.SQL_VSQL_BUILD_VERSION, 's'],
  ['buildCommit', lib.SQL_VSQL_BUILD_COMMIT, 's'],
  ['buildDate', lib.SQL_VSQL_BUILD_DATE, 's'],
  ['buildVVersion', lib.SQL_VSQL_BUILD_V_VERSION, 's'],
  ['buildVCommit', lib.SQL_VSQL_BUILD_V_COMMIT, 's'],
  ['buildCCompiler', lib.SQL_VSQL_BUILD_C_COMPILER, 's'],
  ['operatingSystem', lib.SQL_VSQL_OPERATING_SYSTEM, 's'],
  ['machine', lib.SQL_VSQL_MACHINE, 's'],
  ['fileReadVersion', lib.SQL_VSQL_FILE_READ_VERSION, 'h'],
  ['fileWriteVersion', lib.SQL_VSQL_FILE_WRITE_VERSION, 'h'],
];

// Handles that weren't freed (with close) are freed when their connection or
// statement is garbage collected. Handles are numbers that libvsql reuses, so
// a statement's handle is only freed while its connection is open.
const connections = new FinalizationRegistry((state) => {
  try {
    closeConnection(state);
  } catch {
    // There's nothing to report the error to.
  }
});

const statements = new FinalizationRegistry(({ state, stmt }) => {
  if (state.open) {
    try {
      lib.freeHandle(lib.SQL_HANDLE_STMT, stmt);
    } catch {
      // There's nothing to report the error to.
    }
  }
});

// closeConnection rolls back the transaction (if there is one) and frees the
// handles of a connection, which frees the handles of its statements.
function closeConnection(state) {
  if (!state.open) {
    return;
  }
  state.open = false;

  try {
    if (state.inTransaction) {
      state.inTransaction = false;
      lib.endTran(state.dbc, false);
    }
    lib.disconnect(state.dbc);
  } finally {
    try {
      lib.freeHandle(lib.SQL_HANDLE_DBC, state.dbc);
    } finally {
      lib.freeHandle(lib.SQL_HANDLE_ENV, state.env);
    }
  }
}

// Connection is a connection to a database, see connect.
//
// Each connection has its own environment, so connections in different worker
// threads can be used at the same time.
class Connection {
  constructor(database, options = {}) {
    if (typeof database !== 'string') {
      throw new TypeError('the database must be a string');
    }

    this.name = database;
    this.bigint = Boolean(options.bigint);

    // The handles and state that are needed to close the connection (without
    // the Connection, when it's garbage collected).
    this._state = { env: 0, dbc: 0, open: false, inTransaction: false };

    // The number of transactions (see transaction) that are in another one,
    // each of which is a savepoint.
    this._savepoints = 0;

    // The statements with rows that haven't all been fetched, which are closed
    // when the transaction ends.
    this._cursors = new Set();

    // Whether fn of transaction is running, when commit and rollback can't be
    // called (transaction ends the transaction, or the savepoint, itself).
    this._inFn = false;

    const env = lib.allocHandle(lib.SQL_HANDLE_ENV, lib.SQL_NULL_HANDLE);
    let dbc;
    try {
      dbc = lib.allocHandle(lib.SQL_HANDLE_DBC, env);
      try {
        lib.connect(dbc, database);
      } catch (e) {
        lib.freeHandle(lib.SQL_HANDLE_DBC, dbc);
        throw e;
      }
    } catch (e) {
      lib.freeHandle(lib.SQL_HANDLE_ENV, env);
      throw e;
    }
    Object.assign(this._state, { env, dbc, open: true });
    connections.register(this, this._state, this._state);

    // Each statement is committed when it finishes, unless it's in a
    // transaction started by begin.
    try {
      lib.setAutocommit(dbc, true);
    } catch (e) {
      this.close();
      throw e;
    }
  }

  get open() {
    return this._state.open;
  }

  get inTransaction() {
    return this._state.inTransaction;
  }

  _check() {
    if (!this._state.open) {
      throw new TypeError('the connection is closed');
    }
  }

  // prepare prepares a statement, with a "?" for each parameter.
  prepare(sql) {
    this._check();

    return new Statement(this, sql);
  }

  // run, get, all and iterate prepare a statement, use it once and close it.

  run(sql, params) {
    const stmt = this.prepare(sql);
    try {
      return stmt.run(params);
    } finally {
      stmt.close();
    }
  }

  get(sql, params) {
    const stmt = this.prepare(sql);
    try {
      return stmt.get(params);
    } finally {
      stmt.close();
    }
  }

  all(sql, params) {
    const stmt = this.prepare(sql);
    try {
      return stmt.all(params);
    } finally {
      stmt.close();
    }
  }

  iterate(sql, params) {
    const stmt = this.prepare(sql);
    let rows;
    try {
      rows = stmt.iterate(params);
    } catch (e) {
      stmt.close();
      throw e;
    }

    return (function* closing() {
      try {
        yield* rows;
      } finally {
        stmt.close();
      }
    })();
  }

  // begin starts a transaction, which is ended by commit or rollback. Until
  // then, each statement is committed when it finishes (or when all the rows of
  // a query have been fetched). The options are readOnly (false by default)
  // and isolationLevel ("READ COMMITTED" by default).
  begin(options = {}) {
    this._check();
    if (this._state.inTransaction) {
      throw new TypeError('there is already a transaction');
    }

    const { readOnly = false, isolationLevel = 'READ COMMITTED' } = options;
    const level = isolationLevels.get(isolationLevel);
    if (level === undefined) {
      throw new RangeError(`invalid isolation level: ${JSON.stringify(isolationLevel)}`);
    }
    lib.startTran(this._state.dbc,
      readOnly ? lib.SQL_TRANSACTION_READ_ONLY : lib.SQL_TRANSACTION_READ_WRITE, level);
    this._state.inTransaction = true;
    this._savepoints = 0;
  }

  _end(commit) {
    this._check();
    if (!this._state.inTransaction) {
      return;
    }

    // The rows of the transaction's queries are closed by it.
    for (const stmt of this._cursors) {
      stmt._closeCursor();
    }
    this._state.inTransaction = false;
    lib.endTran(this._state.dbc, commit);
  }

  // commit commits the transaction, if there is one.
  commit() {
    this._checkNotInFn('commit');
    this._end(true);
  }

  _checkNotInFn(name) {
    if (this._inFn) {
      throw new TypeError(`${name}() can't be called in the function of transaction()`);
    }
  }

  // rollback rolls back the transaction, if there is one. With the name of a
  // savepoint (see savepoint), it only rolls back what came after it, and the
  // transaction continues.
  rollback(savepoint) {
    if (savepoint === undefined) {
      this._checkNotInFn('rollback');
      this._end(false);
      return;
    }

    this._checkSavepoint(savepoint);
    lib.endSavepoint(this._state.dbc, savepoint, false);
  }

  // savepoint makes a savepoint in the transaction, which can be rolled back
  // to (see rollback) or released. The name is an identifier, like it is in
  // SQL (so "sp" is SP, and '"sp"' is sp). A savepoint with the same name
  // replaces it.
  savepoint(name) {
    this._checkSavepoint(name);
    this.run(`SAVEPOINT ${name}`);
  }

  // release releases a savepoint, and the savepoints after it, keeping what
  // came after them in the transaction.
  release(name) {
    this._checkSavepoint(name);
    lib.endSavepoint(this._state.dbc, name, true);
  }

  // _checkSavepoint checks the name of a savepoint, and that there's a
  // transaction (vsql accepts SAVEPOINT without one, but it does nothing
  // useful, since each statement is committed on its own).
  _checkSavepoint(name) {
    this._check();
    if (typeof name !== 'string') {
      throw new TypeError('the savepoint must be a string');
    }
    if (!this._state.inTransaction) {
      throw new TypeError('there is no transaction');
    }
  }

  // transaction calls fn in a transaction, which is committed when it returns
  // (and its value is returned), or rolled back if it throws. In another
  // transaction, it uses a savepoint instead, which is released when fn
  // returns, or rolled back to if it throws, so only what fn did is undone.
  // fn can't call commit or rollback (without a savepoint), since then it
  // wouldn't be clear what was committed (like better-sqlite3).
  transaction(fn, options) {
    if (this._state.inTransaction) {
      if (options !== undefined) {
        throw new TypeError("a transaction in another transaction can't have options");
      }
      return this._nested(fn);
    }

    this.begin(options);
    let result;
    this._inFn = true;
    try {
      result = call(fn);
    } catch (e) {
      if (this._state.open) {
        this._end(false);
      }
      throw e;
    } finally {
      this._inFn = false;
    }
    this._end(true);

    return result;
  }

  _nested(fn) {
    const name = `VSQL_NODE_${++this._savepoints}`;
    const inFn = this._inFn;
    try {
      this.run(`SAVEPOINT ${name}`);
      this._inFn = true;
      let result;
      try {
        result = call(fn);
      } catch (e) {
        // fn may have closed the connection.
        if (this._state.open && this._state.inTransaction) {
          lib.endSavepoint(this._state.dbc, name, false);
          lib.endSavepoint(this._state.dbc, name, true);
        }
        throw e;
      }
      lib.endSavepoint(this._state.dbc, name, true);

      return result;
    } finally {
      this._inFn = inFn;
      this._savepoints--;
    }
  }

  // info is the version of vsql and how it was built, and the file format of
  // the database.
  info() {
    this._check();

    const info = {};
    for (const [name, type, kind] of infoFields) {
      info[name] = lib.getInfo(this._state.dbc, type, kind);
    }

    return info;
  }

  // close closes the connection and its statements. A transaction is rolled
  // back. It does nothing if the connection is already closed.
  close() {
    if (!this._state.open) {
      return;
    }

    // The statements (and their rows) are freed by closing the connection.
    for (const stmt of this._cursors) {
      stmt._open = false;
    }
    this._cursors.clear();
    connections.unregister(this._state);
    closeConnection(this._state);
  }

  [Symbol.dispose]() {
    this.close();
  }
}

// call calls the function of a transaction, which can't be async (since the
// transaction would end before it finished).
function call(fn) {
  const result = fn();
  if (typeof result?.then === 'function') {
    throw new TypeError("the function of a transaction can't be async");
  }

  return result;
}

// Statement is a prepared statement, see Connection.prepare. It can be executed
// any number of times, with different parameters.
class Statement {
  constructor(connection, sql) {
    if (typeof sql !== 'string') {
      throw new TypeError('the SQL must be a string');
    }

    this.connection = connection;
    this.sql = sql;
    this._state = connection._state;
    this._raw = false;
    this._open = false;
    this._closed = false;

    // Each execution has a number, so that an iterator only fetches the rows
    // of its own.
    this._execution = 0;
    this._iterating = false;

    this._stmt = lib.allocHandle(lib.SQL_HANDLE_STMT, this._state.dbc);
    try {
      lib.prepare(this._stmt, sql);
      this._describe();
    } catch (e) {
      lib.freeHandle(lib.SQL_HANDLE_STMT, this._stmt);
      throw e;
    }
    statements.register(this, { state: this._state, stmt: this._stmt }, this);
  }

  // _describe reads the columns of the statement (if it's a query).
  _describe(n = lib.numResultCols(this._stmt)) {
    this._described = [];
    this._columns = [];
    this._names = [];
    this._kinds = '';
    this._converters = [];
    // The columns of the key of the rows (if vsql knows it) have a KEY_MEMBER.
    const keyType = n > 0 ? this._ird(0, lib.SQL_DESC_KEY_TYPE) : null;
    for (let i = 1; i <= n; i++) {
      const described = lib.describeCol(this._stmt, i);
      this._described.push(described);
      const [name, dataType, size, digits, nullable] = described;
      const [type, kind, converter] = types.get(dataType) ?? ['', 's', null];
      const c = column(name, type, size, digits, nullable,
        this._ird(i, lib.SQL_DESC_DATETIME_INTERVAL_PRECISION));
      c.key = keyType > 0 && this._ird(i, lib.SQL_DESC_KEY_MEMBER) === 1
        ? keyTypes[keyType] ?? null : null;
      this._columns.push(c);
      this._names.push(name);
      this._kinds += kind === 'I' && this.connection.bigint ? 'b' : kind;
      if (converter !== null) {
        this._converters.push([i - 1, converter]);
      }
    }
  }

  // _changed is true if the columns aren't the same as when they were last
  // described. A table can be replaced (or altered) after the statement was
  // prepared, giving columns with the same count but other names or types.
  // Comparing what describeCol gives is about a third of the work of
  // _describe (which also reads the descriptor fields of each column).
  _changed() {
    const n = lib.numResultCols(this._stmt);
    if (n !== this._described.length) {
      return true;
    }
    for (let i = 0; i < n; i++) {
      const was = this._described[i];
      const now = lib.describeCol(this._stmt, i + 1);
      for (let j = 0; j < now.length; j++) {
        if (now[j] !== was[j]) {
          return true;
        }
      }
    }

    return false;
  }

  // reader is true if the statement returns rows (such as a SELECT). It's
  // only certain once the statement has been executed.
  get reader() {
    return this._columns.length > 0;
  }

  _ird(record, field) {
    return lib.descField(this._stmt, lib.SQL_ATTR_IMP_ROW_DESC, record, field, 'h');
  }

  // columns describes the columns of each row.
  columns() {
    return this._columns.map((c) => ({ ...c }));
  }

  // parameters describes each parameter ("?"), with the type that vsql worked
  // out from where it's used (such as the type of x in "x = ?"). The type is
  // null if it's not known until the statement is executed (such as when its
  // table doesn't exist yet).
  parameters() {
    this._check();

    const ipd = (record, field, kind = 'h') =>
      lib.descField(this._stmt, lib.SQL_ATTR_IMP_PARAM_DESC, record, field, kind);
    const n = ipd(0, lib.SQL_DESC_COUNT) ?? 0;
    const params = [];
    for (let i = 1; i <= n; i++) {
      // The TYPE of a datetime or interval is SQL_DATETIME or SQL_INTERVAL,
      // with its DATETIME_INTERVAL_CODE (the concise code is 90 or 100 more).
      let dataType = ipd(i, lib.SQL_DESC_TYPE);
      if (dataType === lib.SQL_DATETIME || dataType === lib.SQL_INTERVAL) {
        dataType = dataType * 10 + ipd(i, lib.SQL_DESC_DATETIME_INTERVAL_CODE);
      }
      const type = dataType === null ? null : types.get(dataType)?.[0] ?? '';
      const p = {
        type,
        nullable: ipd(i, lib.SQL_DESC_NULLABLE) !== lib.SQL_NO_NULLS,
        length: null,
        precision: null,
        scale: null,
      };
      if (['CHARACTER', 'CHARACTER VARYING', 'BINARY', 'BINARY VARYING'].includes(type)) {
        // The length is in characters (or octets).
        p.length = ipd(i, lib.SQL_DESC_LENGTH, 'i') || null;
      } else if (type === 'DECIMAL' || type === 'NUMERIC') {
        p.precision = ipd(i, lib.SQL_DESC_PRECISION);
        p.scale = ipd(i, lib.SQL_DESC_SCALE);
      } else if (type === 'DECFLOAT' || datetimes.has(type)) {
        p.precision = ipd(i, lib.SQL_DESC_PRECISION);
      } else if (type?.startsWith('INTERVAL ')) {
        p.precision = ipd(i, lib.SQL_DESC_DATETIME_INTERVAL_PRECISION);
        p.scale = type.endsWith('SECOND') ? ipd(i, lib.SQL_DESC_PRECISION) : null;
      }
      params.push(p);
    }

    return params;
  }

  // raw makes each row an array (in the order of the columns) instead of an
  // object, which is needed when columns have the same name.
  raw(on = true) {
    this._raw = Boolean(on);

    return this;
  }

  _check() {
    if (this._closed) {
      throw new TypeError('the statement is closed');
    }
    this.connection._check();
  }

  _closeCursor() {
    if (this._open) {
      this._open = false;
      this._iterating = false;
      this.connection._cursors.delete(this);
      lib.closeCursor(this._stmt);
    }
  }

  _execute(params) {
    this._check();
    if (this._iterating) {
      throw new TypeError('the statement is being iterated');
    }
    const values = toParams(params);
    this._closeCursor();
    this._execution++;
    lib.execute(this._stmt, values);
    if (this._changed()) {
      this._describe();
    }
    if (this.reader) {
      this._open = true;
      this.connection._cursors.add(this);
    }
  }

  // _query executes a statement that must return rows.
  _query(params) {
    this._execute(params);
    if (!this.reader) {
      throw new TypeError("the statement doesn't return rows, use run()");
    }
  }

  _row(values) {
    for (const [i, converter] of this._converters) {
      if (values[i] !== null) {
        values[i] = converter(values[i]);
      }
    }
    if (this._raw) {
      return values;
    }

    const row = {};
    for (let i = 0; i < values.length; i++) {
      row[this._names[i]] = values[i];
    }

    return row;
  }

  _fetch(max) {
    const rows = lib.fetch(this._stmt, this._kinds, max);
    if (max === 0 || rows.length < max) {
      this._closeCursor();
    }

    return rows;
  }

  // run executes the statement. changes is the number of rows that were
  // inserted, updated or deleted.
  run(params) {
    this._execute(params);
    if (this.reader) {
      this._closeCursor();
      return { changes: 0 };
    }

    return { changes: lib.rowCount(this._stmt) };
  }

  // get executes a query and returns its first row, or undefined if there are
  // no rows.
  get(params) {
    this._query(params);
    try {
      const rows = this._fetch(1);
      return rows.length === 0 ? undefined : this._row(rows[0]);
    } finally {
      this._closeCursor();
    }
  }

  // all executes a query and returns all of its rows.
  all(params) {
    this._query(params);
    try {
      return this._fetch(0).map((values) => this._row(values));
    } finally {
      this._closeCursor();
    }
  }

  // iterate executes a query and returns an iterator of its rows, which are
  // fetched one at a time. The statement can't be executed again until the
  // iterator is finished (or exited with break or return). Ending the
  // transaction finishes the iterator.
  iterate(params) {
    this._query(params);
    this._iterating = true;

    const stmt = this;
    const execution = this._execution;
    const current = () => stmt._open && stmt._execution === execution && stmt._state.open;
    return (function* rows() {
      try {
        while (current()) {
          const [values] = stmt._fetch(1);
          if (values === undefined) {
            return;
          }
          yield stmt._row(values);
        }
      } finally {
        if (current()) {
          stmt._closeCursor();
        }
      }
    })();
  }

  // close frees the statement. It does nothing if it's already closed, or if
  // the connection is closed (which closes its statements).
  close() {
    if (this._closed) {
      return;
    }
    this._closed = true;
    statements.unregister(this);
    if (!this._state.open) {
      return;
    }

    try {
      this._closeCursor();
    } finally {
      lib.freeHandle(lib.SQL_HANDLE_STMT, this._stmt);
    }
  }

  [Symbol.dispose]() {
    this.close();
  }
}

// The types that have a fractional seconds precision (such as TIMESTAMP(3)),
// which is their precision.
const datetimes = new Set(['TIME', 'TIME WITH TIME ZONE', 'TIMESTAMP', 'TIMESTAMP WITH TIME ZONE']);

// The key that a column is part of, from KEY_TYPE.
const keyTypes = { 1: 'PRIMARY', 2: 'PREFERRED' };

// column describes a column: its name and type, whether it can be NULL, the
// maximum length of a CHARACTER, CHARACTER VARYING, BINARY or BINARY VARYING,
// the precision and scale of a DECIMAL or NUMERIC (or the precision of a
// DECFLOAT), the fractional seconds precision of a TIME or TIMESTAMP (with or
// without a time zone), and the leading field precision and fractional seconds
// precision of an interval (the others are null). key is the key of the rows that the
// column is part of ("PRIMARY" or "PREFERRED"), if vsql knows it.
function column(name, type, size, digits, nullable, intervalPrecision) {
  let length = null;
  let precision = null;
  let scale = null;
  if (type === 'CHARACTER' || type === 'CHARACTER VARYING') {
    // The size is in octets, with 4 for each character.
    length = size > 0 ? size / 4 : null;
  } else if (type === 'BINARY' || type === 'BINARY VARYING') {
    length = size > 0 ? size : null;
  } else if (type === 'DECIMAL' || type === 'NUMERIC') {
    precision = size;
    scale = digits;
  } else if (type === 'DECFLOAT') {
    precision = size;
  } else if (datetimes.has(type)) {
    // The fractional seconds precision is the decimal digits (the size is the
    // length of the literal).
    precision = digits;
  } else if (type?.startsWith('INTERVAL ')) {
    precision = intervalPrecision;
    scale = type.endsWith('SECOND') ? digits : null;
  }

  return { name, type, nullable: nullable !== lib.SQL_NO_NULLS, length, precision, scale, key: null };
}

module.exports = { Connection, Statement };
