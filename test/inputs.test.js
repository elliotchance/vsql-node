'use strict';

const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');

const vsql = require('..');
const lib = require('../lib/binding');

describe('inputs that the addon does not expect', () => {
  let db;
  beforeEach(() => {
    db = vsql.connect(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  // A Node-API call that fails without throwing (such as reading a string that
  // isn't one) must still throw, rather than return undefined.
  test('an argument of the wrong type to the addon throws', () => {
    assert.throws(() => lib.allocHandle('x', 0), TypeError);
    assert.throws(() => lib.fetch(0, 123, 0), TypeError);

    const stmt = db.prepare('VALUES CAST(? AS VARCHAR(100))');
    try {
      assert.throws(() => lib.execute(stmt._stmt, [[lib.SQL_CHAR, lib.SQL_VARCHAR, 0, 0, 42]]),
        TypeError);
      assert.throws(() => lib.execute(stmt._stmt, [[lib.SQL_BINARY, lib.SQL_VARBINARY, 0, 0, 'x']]),
        TypeError);
      assert.throws(() => lib.execute(stmt._stmt, [42]), TypeError);

      // The statement still works.
      assert.deepEqual(stmt.all(['ok']), [{ COL1: 'ok' }]);
    } finally {
      stmt.close();
    }
  });

  test('SqlValue can only be made by numeric, date, time or timestamp', () => {
    assert.throws(() => new vsql.SqlValue('X', 2, 0, 0, 42), TypeError);
    assert.ok(vsql.numeric('1.5') instanceof vsql.SqlValue);
  });

  test('more than 1,022 columns', () => {
    const n = 1500;
    const exprs = Array.from({ length: n }, (_, i) => `${i} AS c${i}`);
    const row = db.get(`SELECT ${exprs.join(', ')} FROM (VALUES 1) AS t (x)`);
    assert.equal(Object.keys(row).length, n);
    assert.equal(row.C0, 0);
    assert.equal(row.C1499, 1499);
  });

  for (const s of ['\uD800', 'a\uDC00b', 'x\uDBFF']) {
    test(`a string with a lone surrogate ${JSON.stringify(s)} is a RangeError`, () => {
      assert.throws(() => db.get('VALUES CAST(? AS VARCHAR(100))', [s]), {
        name: 'RangeError',
        message: 'parameter 1: a string has a lone surrogate',
      });
    });
  }

  test('a string with a surrogate pair is stored', () => {
    assert.equal(Object.values(db.get('VALUES CAST(? AS VARCHAR(100))', ['a😀b']))[0], 'a\u{1F600}b');
  });
});
