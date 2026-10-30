'use strict';

// The addon (src/binding.c), from prebuilds or build/Release.

const path = require('node:path');

const { VsqlError } = require('./errors');

const lib = require('node-gyp-build')(path.join(__dirname, '..'));

lib.setErrorFactory((sqlstate, message) => new VsqlError(sqlstate, message));

module.exports = lib;
