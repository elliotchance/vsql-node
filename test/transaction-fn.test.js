'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const vsql = require('..');

function xs(db) {
  return db.all('SELECT x FROM t ORDER BY x').map((r) => r.X);
}

test("commit and rollback can't be called in the function of transaction", () => {
  const db = vsql.connect(':memory:');
  db.run('CREATE TABLE t (x INTEGER)');

  // In a transaction, which is rolled back.
  assert.throws(() => db.transaction(() => {
    db.run('INSERT INTO t (x) VALUES (1)');
    db.commit();
  }), { name: 'TypeError', message: "commit() can't be called in the function of transaction()" });
  assert.throws(() => db.transaction(() => db.rollback()), TypeError);
  assert.equal(db.inTransaction, false);
  assert.deepEqual(xs(db), []);

  // In a nested transaction, only the savepoint is rolled back.
  db.transaction(() => {
    db.run('INSERT INTO t (x) VALUES (1)');
    assert.throws(() => db.transaction(() => {
      db.run('INSERT INTO t (x) VALUES (2)');
      db.commit();
    }), /commit\(\) can't be called/);
    assert.throws(() => db.transaction(() => db.rollback()), /rollback\(\) can't be called/);
    assert.equal(db.inTransaction, true);

    // After a nested transaction, they still can't be called.
    assert.throws(() => db.commit(), TypeError);
  });
  assert.equal(db.inTransaction, false);
  assert.deepEqual(xs(db), [1]);

  // A nested transaction in a transaction started by begin.
  db.begin();
  db.run('INSERT INTO t (x) VALUES (3)');
  assert.throws(() => db.transaction(() => db.commit()), TypeError);
  assert.equal(db.inTransaction, true);
  db.commit();
  assert.deepEqual(xs(db), [1, 3]);

  // Rolling back to a savepoint is allowed.
  db.transaction(() => {
    db.run('SAVEPOINT a');
    db.run('INSERT INTO t (x) VALUES (4)');
    db.rollback('a');
  });
  assert.deepEqual(xs(db), [1, 3]);

  // After transaction, commit and rollback can be called again.
  db.commit();
  db.rollback();
  db.close();
});
