'use strict';

// NaN and the infinities can't be a parameter, since vsql doesn't have them.

const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');

const vsql = require('..');

describe('non-finite numbers', () => {
  let db;
  beforeEach(() => {
    db = vsql.connect(':memory:');
    db.run('CREATE TABLE t (d DOUBLE PRECISION)');
  });
  afterEach(() => {
    db.close();
  });

  for (const value of [NaN, Infinity, -Infinity]) {
    test(`${value} is a RangeError`, () => {
      assert.throws(() => db.run('INSERT INTO t (d) VALUES (?)', [value]), (e) => {
        assert.ok(e instanceof RangeError, e);
        assert.match(e.message, new RegExp(`parameter 1: invalid number: ${value}`));
        return true;
      });
      assert.equal(db.get('SELECT COUNT(*) AS c FROM t').C, 0);
    });

    test(`numeric(${value}) is a RangeError`, () => {
      assert.throws(() => vsql.numeric(value), RangeError);
    });
  }

  test('a finite double is still a parameter', () => {
    db.run('INSERT INTO t (d) VALUES (?)', [1.5]);
    assert.equal(db.get('SELECT d FROM t').D, 1.5);
  });
});
