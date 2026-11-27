'use strict';

const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');

const vsql = require('..');

describe('a prepared statement after its table changes', () => {
  let db;
  beforeEach(() => {
    db = vsql.connect(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  test('reads columns with the new types', () => {
    db.run('CREATE TABLE u (a INTEGER)');
    db.run('INSERT INTO u (a) VALUES (5)');
    const st = db.prepare('SELECT * FROM u');
    assert.deepEqual(st.all(), [{ A: 5 }]);

    db.run('DROP TABLE u');
    db.run('CREATE TABLE u (a VARCHAR(10))');
    db.run("INSERT INTO u (a) VALUES ('hello')");
    assert.deepEqual(st.all(), [{ A: 'hello' }]);
    assert.equal(st.columns()[0].type, 'CHARACTER VARYING');
    assert.equal(st.columns()[0].length, 10);

    // And back again, which would otherwise read the INTEGER as a string.
    db.run('DROP TABLE u');
    db.run('CREATE TABLE u (a INTEGER)');
    db.run('INSERT INTO u (a) VALUES (7)');
    assert.deepEqual(st.all(), [{ A: 7 }]);
    assert.equal(st.columns()[0].type, 'INTEGER');
    st.close();
  });

  test('reads columns with the new names', () => {
    db.run('CREATE TABLE u (a INTEGER)');
    db.run('INSERT INTO u (a) VALUES (5)');
    const st = db.prepare('SELECT * FROM u');
    assert.deepEqual(st.get(), { A: 5 });

    db.run('DROP TABLE u');
    db.run('CREATE TABLE u (b INTEGER)');
    db.run('INSERT INTO u (b) VALUES (6)');
    assert.deepEqual(st.get(), { B: 6 });
    assert.equal(st.columns()[0].name, 'B');

    // The iterator uses the columns of its own execution.
    assert.deepEqual([...st.iterate()], [{ B: 6 }]);
    st.close();
  });

  test('reads columns with a new size', () => {
    db.run('CREATE TABLE u (a VARCHAR(10))');
    const st = db.prepare('SELECT * FROM u');
    assert.equal(st.columns()[0].length, 10);
    db.run('DROP TABLE u');
    db.run('CREATE TABLE u (a VARCHAR(20))');
    st.run();
    assert.equal(st.columns()[0].length, 20);
    st.close();
  });
});
