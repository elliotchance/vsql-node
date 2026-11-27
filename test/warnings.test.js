'use strict';

const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');

const vsql = require('..');

// warnings is the warnings that fn emits. process.emitWarning emits them on
// the next tick.
async function warnings(fn) {
  const got = [];
  const listener = (w) => {
    if (w instanceof vsql.VsqlWarning) {
      got.push(w);
    }
  };
  process.on('warning', listener);
  try {
    fn();
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }

  return got;
}

describe('warnings and diagnostics', () => {
  let db;
  beforeEach(() => {
    db = vsql.connect(':memory:');
    db.run('CREATE TABLE t (x INTEGER)');
    db.run('INSERT INTO t (x) VALUES (1)');
    db.run('INSERT INTO t (x) VALUES (NULL)');
  });
  afterEach(() => {
    db.close();
  });

  test('a NULL eliminated in a set function is a warning', async () => {
    let rows;
    const got = await warnings(() => {
      rows = db.all('SELECT SUM(x) AS s FROM t');
    });
    assert.deepEqual(rows, [{ S: 1 }]);
    assert.equal(got.length, 1);
    assert.equal(got[0].name, 'VsqlWarning');
    assert.equal(got[0].sqlstate, '01003');
    assert.equal(got[0].code, '01003');
    assert.equal(got[0].message, 'null value eliminated in set function (SQLSTATE 01003)');
  });

  test('a truncated string is a warning', async () => {
    const got = await warnings(() => {
      assert.equal(Object.values(db.get("VALUES CAST('abcdef' AS VARCHAR(2))"))[0], 'ab');
    });
    assert.deepEqual(got.map((w) => w.sqlstate), ['01004']);
  });

  // Long strings and values are read in pieces, which libvsql truncates.
  test('reading a long value is not a warning', async () => {
    db.run('CREATE TABLE s (s VARCHAR(2000), b VARBINARY(2000))');
    db.run('INSERT INTO s (s, b) VALUES (?, ?)', ['y'.repeat(1000), Buffer.alloc(1000)]);
    const got = await warnings(() => {
      db.all('SELECT s, b FROM s');
      db.all('SELECT SUM(x) FROM t WHERE x IS NOT NULL');
    });
    assert.deepEqual(got, []);
  });

  test('the other records of an error are its diagnostics', () => {
    assert.throws(() => db.all('SELECT SUM(x) / 0 FROM t'), (e) => {
      assert.ok(e instanceof vsql.VsqlError);
      assert.equal(e.sqlstate, '22012');
      assert.deepEqual(e.diagnostics, [
        { sqlstate: '01003', message: 'null value eliminated in set function' },
      ]);
      return true;
    });
  });

  test('an error with one record has no diagnostics', () => {
    assert.throws(() => db.all('SELECT * FROM nope'), (e) => {
      assert.equal(e.sqlstate, '42P01');
      assert.deepEqual(e.diagnostics, []);
      return true;
    });
  });
});
