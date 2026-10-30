'use strict';

const lib = require('./binding');
const { toParams, types } = require('./convert');

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

    // The statements with rows that haven't all been fetched, which are closed
    // when the transaction ends.
    this._cursors = new Set();

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
  // a query have been fetched).
  begin() {
    this._check();
    if (this._state.inTransaction) {
      throw new TypeError('there is already a transaction');
    }

    // vsql's transactions are READ COMMITTED.
    lib.startTran(this._state.dbc, lib.SQL_TRANSACTION_READ_WRITE,
      lib.SQL_TRANSACTION_READ_COMMITTED);
    this._state.inTransaction = true;
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
    this._end(true);
  }

  // rollback rolls back the transaction, if there is one.
  rollback() {
    this._end(false);
  }

  // transaction calls fn in a transaction, which is committed when it returns
  // (and its value is returned), or rolled back if it throws.
  transaction(fn) {
    this.begin();
    let result;
    try {
      result = fn();
      if (typeof result?.then === 'function') {
        throw new TypeError("the function of a transaction can't be async");
      }
    } catch (e) {
      if (this._state.open) {
        this.rollback();
      }
      throw e;
    }
    this.commit();

    return result;
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

  // _describe reads the columns of the statement (if it's a query). A
  // statement can have no columns until it's executed (such as a SELECT from a
  // table that doesn't exist yet), so n is given again after each execution.
  _describe(n = lib.numResultCols(this._stmt)) {
    this._columns = [];
    this._names = [];
    this._kinds = '';
    this._converters = [];
    for (let i = 1; i <= n; i++) {
      const [name, dataType, size, digits, nullable] = lib.describeCol(this._stmt, i);
      const [type, kind, converter] = types.get(dataType) ?? ['', 's', null];
      this._columns.push(column(name, type, size, digits, nullable));
      this._names.push(name);
      this._kinds += kind === 'I' && this.connection.bigint ? 'b' : kind;
      if (converter !== null) {
        this._converters.push([i - 1, converter]);
      }
    }
  }

  // reader is true if the statement returns rows (such as a SELECT). It's
  // only certain once the statement has been executed.
  get reader() {
    return this._columns.length > 0;
  }

  // columns describes the columns of each row.
  columns() {
    return this._columns.map((c) => ({ ...c }));
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
    const n = lib.numResultCols(this._stmt);
    if (n !== this._columns.length) {
      this._describe(n);
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

// column describes a column: its name and type, whether it can be NULL, the
// maximum length of a CHARACTER or CHARACTER VARYING, and the precision and
// scale of a DECIMAL or NUMERIC (the others are null).
function column(name, type, size, digits, nullable) {
  let length = null;
  let precision = null;
  let scale = null;
  if (type === 'CHARACTER' || type === 'CHARACTER VARYING') {
    // The size is in octets, with 4 for each character.
    length = size > 0 ? size / 4 : null;
  } else if (type === 'DECIMAL' || type === 'NUMERIC') {
    precision = size;
    scale = digits;
  }

  return { name, type, nullable: nullable !== lib.SQL_NO_NULLS, length, precision, scale };
}

module.exports = { Connection, Statement };
