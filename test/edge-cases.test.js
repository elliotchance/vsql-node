'use strict';

// Cases that the other tests don't reach, mostly of the addon (src/binding.c).

const assert = require('node:assert/strict');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');

const vsql = require('..');
const lib = require('../lib/binding');
const { typeOf } = require('../lib/convert');

// An identifier of 128 characters of 4 octets each (512 octets), which is
// longer than the buffers that the addon reads names and messages into first.
const longName = '\u{1F600}'.repeat(128);

describe('edge cases', () => {
  let db;
  beforeEach(() => {
    db = vsql.connect(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  test('an invalid handle is an error', () => {
    assert.throws(() => lib.freeHandle(lib.SQL_HANDLE_STMT, 99999),
      { name: 'VsqlError', sqlstate: 'HY000', message: /invalid handle/ });
  });

  test('too few arguments to the addon is a TypeError', () => {
    assert.throws(() => lib.connect(), { name: 'TypeError', message: 'not enough arguments' });
  });

  test('an exception while reading the parameters is thrown', () => {
    const stmt = db.prepare('VALUES CAST(? AS INTEGER)');
    try {
      const params = [];
      Object.defineProperty(params, 0, {
        get() {
          throw new Error('boom');
        },
      });
      assert.throws(() => lib.execute(stmt._stmt, params), { message: 'boom' });
    } finally {
      stmt.close();
    }
    assert.throws(() => db.iterate('VALUES CAST(? AS INTEGER)', [Symbol('x')]), TypeError);
  });

  test('long names and messages', () => {
    assert.throws(() => db.run(`SELECT * FROM "${longName}"`),
      (e) => e.sqlstate === '42P01' && e.message.includes(longName));
    const stmt = db.prepare(`SELECT 1 AS "${longName}" FROM (VALUES 1) AS t (x)`);
    try {
      assert.equal(stmt.columns()[0].name, longName);
    } finally {
      stmt.close();
    }
  });

  // With a diagnostics size of 1, a failed statement has no room for its
  // warnings.
  test('an error with more conditions than the diagnostics size', () => {
    db.run('SET SESSION CHARACTERISTICS AS TRANSACTION DIAGNOSTICS SIZE 1');
    assert.throws(() => db.all('SELECT SUM(x) / 0 FROM (VALUES CAST(NULL AS INT), 1) AS t (x)'),
      { sqlstate: '22012', more: true });
  });

  test('a descriptor field that is not set, or a record that does not exist', () => {
    const stmt = db.prepare('VALUES CAST(? AS INTEGER)');
    try {
      assert.equal(lib.descField(stmt._stmt, lib.SQL_ATTR_IMP_PARAM_DESC, 5, lib.SQL_DESC_TYPE, 'h'),
        null);
      assert.equal(lib.descField(stmt._stmt, lib.SQL_ATTR_IMP_PARAM_DESC, 1, lib.SQL_DESC_KEY_TYPE,
        'h'), null);
    } finally {
      stmt.close();
    }
  });

  test('a table that has more columns after the statement was prepared', () => {
    db.run('CREATE TABLE t (a INTEGER)');
    db.run('INSERT INTO t (a) VALUES (1)');
    const stmt = db.prepare('SELECT * FROM t');
    try {
      assert.deepEqual(stmt.all(), [{ A: 1 }]);
      db.run('DROP TABLE t');
      db.run('CREATE TABLE t (a INTEGER, b INTEGER)');
      db.run('INSERT INTO t (a, b) VALUES (2, 3)');
      assert.deepEqual(stmt.all(), [{ A: 2, B: 3 }]);
    } finally {
      stmt.close();
    }
  });

  // A type from a newer vsql is read as a string, and a type that vsql doesn't
  // know (null) has a null name.
  test('the types that the package does not know', () => {
    assert.deepEqual(typeOf(lib.SQL_INTEGER), ['INTEGER', 'i', null]);
    assert.deepEqual(typeOf(9999), ['', 's', null]);
    assert.deepEqual(typeOf(null), [null, 's', null]);
  });

  // lib/binding.js gives the addon the functions that make errors and report
  // warnings, which can be replaced (it's loaded again to put them back).
  describe('the error and warning functions', () => {
    const binding = path.join(__dirname, '..', 'lib', 'binding.js');
    afterEach(() => {
      delete require.cache[binding];
      require(binding);
    });

    test('an error function that throws', () => {
      lib.setErrorFactory(() => {
        throw new Error('no errors');
      }, () => {
        throw new Error('no warnings');
      });
      assert.throws(() => db.run('SELECT * FROM nope'), { message: 'no errors' });
      assert.throws(() => db.all('SELECT SUM(x) FROM (VALUES CAST(NULL AS INT)) AS t (x)'),
        { message: 'no warnings' });
    });

    // Without them (a reference can't be made to null), an error is an Error
    // with the SQLSTATE as its code, and warnings are ignored.
    test('no error function', () => {
      assert.throws(() => lib.setErrorFactory(null, null), TypeError);
      assert.throws(() => db.run('SELECT * FROM nope'),
        (e) => e.constructor === Error && e.code === '42P01');
      assert.deepEqual(db.all('SELECT SUM(x) AS s FROM (VALUES CAST(NULL AS INT)) AS t (x)'),
        [{ S: null }]);
    });
  });
});
