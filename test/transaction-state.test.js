'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const vsql = require('..');

// tempPath is the path of a new database file, in a folder that's removed
// after the test.
function tempPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsql-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return path.join(dir, 'test.vsql');
}

// conflict makes b's transaction fail with a 40001 (which vsql rolls back),
// after b inserted 50. a's transaction is committed.
function conflict(file, b) {
  const a = vsql.connect(file);
  try {
    a.begin();
    a.run('UPDATE t SET x = 100 WHERE x = 1');
    b.run('INSERT INTO t (x) VALUES (50)');
    assert.throws(() => b.run('UPDATE t SET x = 200 WHERE x = 1'),
      (e) => e.sqlstate === '40001');
    a.commit();
  } finally {
    a.close();
  }
}

function setup(t) {
  const file = tempPath(t);
  const db = vsql.connect(file);
  db.run('CREATE TABLE t (x INT PRIMARY KEY)');
  db.run('INSERT INTO t (x) VALUES (1)');
  db.close();

  return file;
}

function xs(file) {
  const db = vsql.connect(file);
  try {
    return db.all('SELECT x FROM t ORDER BY x').map((r) => r.X);
  } finally {
    db.close();
  }
}

test('the transaction ends when vsql rolls it back', (t) => {
  const file = setup(t);
  const b = vsql.connect(file);
  b.begin();
  const rows = b.prepare('SELECT x FROM t').iterate();
  conflict(file, b);
  assert.equal(b.inTransaction, false);
  assert.equal(rows.next().done, true);

  // Without a transaction, a statement is committed.
  b.run('INSERT INTO t (x) VALUES (60)');
  b.rollback();
  assert.deepEqual(xs(file), [60, 100]);

  // A new transaction can be started, and rolled back.
  b.begin();
  b.run('INSERT INTO t (x) VALUES (70)');
  b.rollback();
  assert.deepEqual(xs(file), [60, 100]);
  b.close();
});

test('other errors only undo the statement', (t) => {
  const file = setup(t);
  const db = vsql.connect(file);
  db.begin();
  db.run('INSERT INTO t (x) VALUES (2)');
  assert.throws(() => db.run('INSERT INTO t (x) VALUES (2)'), vsql.VsqlError);
  assert.throws(() => db.get('SELECT 1 / 0 FROM t'), vsql.VsqlError);
  assert.equal(db.inTransaction, true);
  db.rollback();
  assert.deepEqual(xs(file), [1]);
  db.close();
});

test('statements after vsql rolls back the transaction of fn fail', (t) => {
  const file = setup(t);
  const b = vsql.connect(file);
  assert.throws(() => b.transaction(() => {
    conflict(file, b);
    assert.throws(() => b.run('INSERT INTO t (x) VALUES (60)'), /rolled back by vsql/);
  }), /rolled back by vsql/);
  assert.equal(b.inTransaction, false);
  assert.deepEqual(xs(file), [100]);
  b.close();
});

test('the same in a nested transaction', (t) => {
  const file = setup(t);
  const b = vsql.connect(file);
  assert.throws(() => b.transaction(() => {
    b.run('INSERT INTO t (x) VALUES (2)');
    b.transaction(() => conflict(file, b));
  }), /rolled back by vsql/);
  assert.equal(b.inTransaction, false);
  assert.deepEqual(xs(file), [100]);
  b.close();
});
