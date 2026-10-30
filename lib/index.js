'use strict';

// vsql-node is a driver for vsql (https://github.com/elliotchance/vsql), a
// single file or in-memory SQL database. libvsql (the vsql library) is compiled
// into the package, so nothing else needs to be installed.
//
//   const vsql = require('vsql-node');
//
//   const db = vsql.connect('test.vsql');
//   db.run('CREATE TABLE foo (x INTEGER)');
//   db.run('INSERT INTO foo (x) VALUES (?)', [123]);
//   db.all('SELECT x FROM foo'); // [{ X: 123 }]
//   db.close();
//
// The API is synchronous: each call runs vsql on the calling thread. See the
// README for transactions, parameters and the JavaScript type of each column
// type.

const { Connection, Statement } = require('./connection');
const { SqlValue, numeric, date, time, timestamp } = require('./convert');
const { VsqlError } = require('./errors');

// connect opens a connection to a database file (which is created if it
// doesn't exist), or ":memory:" for a database that only exists for the life
// of the connection. With { bigint: true }, a BIGINT column is a bigint
// (otherwise it's a number, and a RangeError if it doesn't fit).
function connect(database, options) {
  return new Connection(database, options);
}

module.exports = {
  connect,
  Connection,
  Statement,
  VsqlError,
  SqlValue,
  numeric,
  date,
  time,
  timestamp,
};
