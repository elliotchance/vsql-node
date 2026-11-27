'use strict';

// VsqlError is an error from vsql. Errors from the driver itself (such as using
// a closed connection, or a value that can't be a parameter) are a TypeError
// or RangeError instead.
class VsqlError extends Error {
  // sqlstate is the SQLSTATE of the error (such as "42P01" for an undefined
  // table), which is also the code. fields are the other fields of the
  // diagnostic (see binding.c), which are only set when vsql gives them: the
  // constraint that was violated (constraintCatalog, constraintSchema and
  // constraintName), the table or column (catalogName, schemaName, tableName
  // and columnName) and the cursor (cursorName). more is true if vsql raised
  // more conditions than it kept.
  //
  // diagnostics are the other conditions that vsql raised with the error (each
  // an object of sqlstate, message and the same fields), which is usually
  // empty.
  constructor(sqlstate, message, fields = {}) {
    super(`${message} (SQLSTATE ${sqlstate})`);
    this.name = 'VsqlError';
    this.sqlstate = sqlstate;
    this.code = sqlstate;
    setFields(this, fields);
    this.more = Boolean(fields.more);
    this.diagnostics = (fields.diagnostics ?? []).map((record) => {
      const d = { sqlstate: record.sqlstate, message: record.message };
      setFields(d, record);
      return d;
    });
  }
}

// VsqlWarning is a warning from vsql (a completion condition, such as "01003"
// when a NULL is eliminated from SUM), when a statement still succeeds. Each
// warning is given to process.emitWarning, which is how Node reports problems
// that shouldn't stop the program: they're printed to stderr, unless there's
// a listener for process.on('warning') or Node is run with --no-warnings (or
// --disable-warning=VsqlWarning). It has the same fields as VsqlError.
class VsqlWarning extends Error {
  constructor(sqlstate, message, fields = {}) {
    super(`${message} (SQLSTATE ${sqlstate})`);
    this.name = 'VsqlWarning';
    this.sqlstate = sqlstate;
    this.code = sqlstate;
    setFields(this, fields);
  }
}

// setFields copies the diagnostic fields that vsql gave.
function setFields(target, fields) {
  for (const name of FIELDS) {
    if (fields[name] !== undefined) {
      target[name] = fields[name];
    }
  }
}

const FIELDS = [
  'constraintCatalog',
  'constraintSchema',
  'constraintName',
  'catalogName',
  'schemaName',
  'tableName',
  'columnName',
  'cursorName',
];

module.exports = { VsqlError, VsqlWarning };
