'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const vsql = require('..');

// tempPath is the path of a new database file, in a folder that's removed
// after the test. The hooks of t.after run in the order they're added, so the
// connections to it must be closed by the test (Windows can't remove a file
// that's open).
function tempPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsql-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return path.join(dir, 'test.vsql');
}

function xs(db) {
  return db.all('SELECT x FROM t ORDER BY x').map((r) => r.X);
}

// collect runs the garbage collector, and the finalizers that it queues.
async function collect() {
  await new Promise((resolve) => setImmediate(resolve));
  global.gc();
  await new Promise((resolve) => setImmediate(resolve));
}

test('a transaction while iterating is an error', (t) => {
  const db = vsql.connect(tempPath(t));
  t.after(() => db.close());
  db.run('CREATE TABLE t (x INTEGER)');
  db.run('INSERT INTO t (x) VALUES (1)');
  db.run('INSERT INTO t (x) VALUES (2)');

  // The error names the query, instead of a VsqlError 25001.
  const want = { name: 'TypeError', message: /haven't all been fetched \("SELECT x FROM t"\)/ };
  assert.throws(() => {
    for (const row of db.iterate('SELECT x FROM t')) {
      db.transaction(() => db.run('UPDATE t SET x = x + 10 WHERE x = ?', [row.X]));
    }
  }, want);
  assert.equal(db.inTransaction, false);

  // Leaving the loop closed the rows, so a transaction can start.
  db.transaction(() => db.run('UPDATE t SET x = x + 10'));
  assert.deepEqual(xs(db), [11, 12]);

  // A statement's iterator that's part way through.
  const stmt = db.prepare('SELECT x FROM t');
  const rows = stmt.iterate();
  rows.next();
  assert.throws(() => db.begin(), want);
  rows.return();
  db.begin();
  db.rollback();
  stmt.close();
  db.close();
});

test('db.iterate executes when the iterator is first advanced', (t) => {
  const file = tempPath(t);
  const a = vsql.connect(file);
  const b = vsql.connect(file);
  t.after(() => {
    a.close();
    b.close();
  });
  a.run('CREATE TABLE t (x INTEGER)');

  // An error is only raised when it's executed.
  const nope = a.iterate('SELECT * FROM nope');
  assert.throws(() => nope.next(), vsql.VsqlError);

  // An iterator that isn't started doesn't hold a transaction.
  const rows = a.iterate('SELECT x FROM t');
  b.run('INSERT INTO t (x) VALUES (1)');
  a.begin();
  a.rollback();
  assert.deepEqual([...rows], [{ X: 1 }]);

  a.close();
  assert.throws(() => a.iterate('SELECT x FROM t'), /connection is closed/);
  b.close();
});

test('a forgotten iterator is closed when it is garbage collected', async (t) => {
  const file = tempPath(t);
  const a = vsql.connect(file);
  const b = vsql.connect(file);
  t.after(() => {
    a.close();
    b.close();
  });
  a.run('CREATE TABLE t (x INTEGER)');
  a.run('INSERT INTO t (x) VALUES (1)');
  a.run('INSERT INTO t (x) VALUES (2)');

  (() => {
    a.iterate('SELECT x FROM t').next();
    a.prepare('SELECT x FROM t').iterate().next();
  })();
  await collect();

  // Without the lock, b doesn't wait for lock_timeout.
  b.run('INSERT INTO t (x) VALUES (3)');
  a.transaction(() => a.run('INSERT INTO t (x) VALUES (4)'));
  assert.deepEqual(xs(b), [1, 2, 3, 4]);
  a.close();
  b.close();
});

// Closing the connection frees the statements with rows that haven't all been
// fetched, including one that was garbage collected before its finalizer ran.
test('closing the connection while iterating', async () => {
  const db = vsql.connect(':memory:');
  const stmt = db.prepare('VALUES 1, 2');
  const rows = stmt.iterate();
  assert.deepEqual(rows.next().value, { COL1: 1 });
  (() => {
    db.prepare('VALUES 3, 4').iterate().next();
  })();

  // The finalizers run after the garbage collector, so the forgotten statement
  // is still a cursor of the connection when it's closed.
  await new Promise((resolve) => setImmediate(resolve));
  global.gc();
  db.close();
  // The iterator is finished, like it is by ending the transaction.
  assert.deepEqual(rows.next(), { done: true, value: undefined });
  await new Promise((resolve) => setImmediate(resolve));
});
