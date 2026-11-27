'use strict';

// The precision of a TIME or TIMESTAMP is its fractional seconds precision.

const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');

const vsql = require('..');

describe('fractional seconds precision', () => {
  let db;
  beforeEach(() => {
    db = vsql.connect(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  // The default is 0 for a TIME and 6 for a TIMESTAMP.
  for (const [type, name, precision] of [
    ['TIME', 'TIME', 0],
    ['TIME(6)', 'TIME', 6],
    ['TIME WITH TIME ZONE', 'TIME WITH TIME ZONE', 0],
    ['TIME(2) WITH TIME ZONE', 'TIME WITH TIME ZONE', 2],
    ['TIMESTAMP', 'TIMESTAMP', 6],
    ['TIMESTAMP(0)', 'TIMESTAMP', 0],
    ['TIMESTAMP(3)', 'TIMESTAMP', 3],
    ['TIMESTAMP WITH TIME ZONE', 'TIMESTAMP WITH TIME ZONE', 6],
    ['TIMESTAMP(1) WITH TIME ZONE', 'TIMESTAMP WITH TIME ZONE', 1],
  ]) {
    test(type, () => {
      db.run(`CREATE TABLE t (x ${type})`);
      const want = { type: name, nullable: true, length: null, precision, scale: null };
      assert.deepEqual(db.prepare('SELECT x FROM t').columns(), [{ name: 'X', ...want, key: null }]);
      assert.deepEqual(db.prepare('SELECT * FROM t WHERE x = ?').parameters(), [want]);
    });
  }

  test('CAST', () => {
    const columns = db.prepare(
      'VALUES ROW(CAST(NULL AS TIMESTAMP(3)), CAST(NULL AS TIME(6)))').columns();
    assert.deepEqual(columns.map((c) => [c.type, c.precision]), [['TIMESTAMP', 3], ['TIME', 6]]);
  });

  test('DATE has no precision', () => {
    db.run('CREATE TABLE t (x DATE)');
    assert.equal(db.prepare('SELECT x FROM t').columns()[0].precision, null);
    assert.equal(db.prepare('SELECT * FROM t WHERE x = ?').parameters()[0].precision, null);
  });
});
