'use strict';

// VsqlError is an error from vsql. Errors from the driver itself (such as using
// a closed connection, or a value that can't be a parameter) are a TypeError
// or RangeError instead.
class VsqlError extends Error {
  // sqlstate is the SQLSTATE of the error (such as "42P01" for an undefined
  // table), which is also the code.
  constructor(sqlstate, message) {
    super(`${message} (SQLSTATE ${sqlstate})`);
    this.name = 'VsqlError';
    this.sqlstate = sqlstate;
    this.code = sqlstate;
  }
}

module.exports = { VsqlError };
