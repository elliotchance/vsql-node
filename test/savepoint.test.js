'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');

const vsql = require('..');

function xs(db) {
  return db.all('SELECT x FROM t ORDER BY x').map((r) => r.X);
}

test('savepoint, release and rollback to a savepoint', () => {
  const db = vsql.connect(':memory:');
  db.run('CREATE TABLE t (x INTEGER)');
  db.begin();
  db.run('INSERT INTO t (x) VALUES (1)');
  db.savepoint('a');
  db.run('INSERT INTO t (x) VALUES (2)');
  db.savepoint('"b c"');
  db.run('INSERT INTO t (x) VALUES (3)');
  db.rollback('"b c"');
  assert.deepEqual(xs(db), [1, 2]);

  // The name is an identifier, so a is A.
  db.rollback('A');
  assert.deepEqual(xs(db), [1]);

  // Releasing a savepoint keeps what came after it.
  db.run('INSERT INTO t (x) VALUES (4)');
  db.release('a');
  assert.throws(() => db.rollback('a'), (e) => e.sqlstate === '3B001');
  assert.throws(() => db.release('a'), (e) => e.sqlstate === '3B001');
  assert.deepEqual(xs(db), [1, 4]);

  // Releasing a savepoint releases the ones after it.
  db.savepoint('c');
  db.savepoint('d');
  db.release('c');
  assert.throws(() => db.release('d'), (e) => e.sqlstate === '3B001');

  assert.throws(() => db.savepoint(1), TypeError);
  assert.throws(() => db.release(1), TypeError);
  assert.equal(db.inTransaction, true);
  db.commit();
  assert.deepEqual(xs(db), [1, 4]);
  db.close();
});

test('savepoints need a transaction', () => {
  const db = vsql.connect(':memory:');
  assert.throws(() => db.savepoint('a'), { name: 'TypeError', message: 'there is no transaction' });
  assert.throws(() => db.release('a'), { name: 'TypeError', message: 'there is no transaction' });
  assert.throws(() => db.rollback('a'), { name: 'TypeError', message: 'there is no transaction' });
  db.close();
  assert.throws(() => db.savepoint('a'), /closed/);
});
