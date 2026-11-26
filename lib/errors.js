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
  constructor(sqlstate, message, fields = {}) {
    super(`${message} (SQLSTATE ${sqlstate})`);
    this.name = 'VsqlError';
    this.sqlstate = sqlstate;
    this.code = sqlstate;
    for (const name of FIELDS) {
      if (fields[name] !== undefined) {
        this[name] = fields[name];
      }
    }
    this.more = Boolean(fields.more);
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

module.exports = { VsqlError };
