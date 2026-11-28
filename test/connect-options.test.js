'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const vsql = require('..');

// tempPath is the path of a new database file, in a folder that's removed
// after the test (the connections to it must be closed by the test first).
function tempPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsql-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return path.join(dir, 'test.vsql');
}

// defaultIsolation is the isolation level of a statement outside of a
// transaction (2 is READ COMMITTED and 4 is SERIALIZABLE).
function defaultIsolation(db) {
  return db.get(`SELECT INTEGER_VALUE AS v FROM INFORMATION_SCHEMA.SQL_IMPLEMENTATION_INFO
    WHERE IMPLEMENTATION_INFO_NAME = 'DEFAULT TRANSACTION ISOLATION'`).V;
}

test('a lockTimeout of 0 fails straight away instead of waiting', (t) => {
  const file = tempPath(t);
  const a = vsql.connect(file);
  const b = vsql.connect(file, { lockTimeout: 0 });
  try {
    a.run('CREATE TABLE t (x INTEGER)');
    a.begin({ isolationLevel: 'SERIALIZABLE' });
    a.run('INSERT INTO t (x) VALUES (1)');

    const start = Date.now();
    assert.throws(() => b.run('INSERT INTO t (x) VALUES (2)'), { sqlstate: '40001' });
    assert.ok(Date.now() - start < 1000);
  } finally {
    b.close();
    a.close();
  }
});

test('isolationLevel is the isolation level of statements outside of a transaction', () => {
  const db = vsql.connect(':memory:', { isolationLevel: 'READ COMMITTED' });
  try {
    assert.equal(defaultIsolation(db), 2);
  } finally {
    db.close();
  }

  const serializable = vsql.connect(':memory:');
  try {
    assert.equal(defaultIsolation(serializable), 4);
  } finally {
    serializable.close();
  }
});

test('the other options', () => {
  const db = vsql.connect(':memory:', {
    createIndexTimeout: 100, cacheSize: 0, pageSize: 1024, fullFsync: true,
  });
  try {
    db.run('CREATE TABLE t (x INTEGER)');
    db.run('CREATE INDEX i ON t (x)');
    assert.deepEqual(db.all('SELECT * FROM t'), []);
  } finally {
    db.close();
  }
  vsql.connect(':memory:', { fullFsync: false }).close();
});

test('an option that is not valid', () => {
  for (const lockTimeout of [-1, 1.5, '1', 2 ** 31, NaN]) {
    assert.throws(() => vsql.connect(':memory:', { lockTimeout }),
      { name: 'RangeError', message: 'lockTimeout must be an integer from 0 to 2147483647' });
  }
  assert.throws(() => vsql.connect(':memory:', { isolationLevel: 'serializable' }),
    { name: 'RangeError', message: 'invalid isolation level: "serializable"' });

  // libvsql checks the range of each option.
  assert.throws(() => vsql.connect(':memory:', { pageSize: 16 }),
    { name: 'VsqlError', sqlstate: 'HY024' });
});
