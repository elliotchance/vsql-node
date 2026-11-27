'use strict';

// The addon (src/binding.c), from prebuilds or build/Release.

const path = require('node:path');

const { VsqlError, VsqlWarning } = require('./errors');

const lib = require('node-gyp-build')(path.join(__dirname, '..'));

lib.setErrorFactory(
  (sqlstate, message, fields) => new VsqlError(sqlstate, message, fields),
  (records) => {
    for (const record of records) {
      process.emitWarning(new VsqlWarning(record.sqlstate, record.message, record));
    }
  },
);

module.exports = lib;
