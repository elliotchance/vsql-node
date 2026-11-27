'use strict';

const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');

const vsql = require('..');

describe('strings that contain U+0000', () => {
  let db;
  beforeEach(() => {
    db = vsql.connect(':memory:');
    db.run('CREATE TABLE t (s VARCHAR(2000))');
  });
  afterEach(() => {
    db.close();
  });

  // A string of 256 octets or more is read in pieces, so U+0000 is tried in
  // the first piece, the last piece and in a short string.
  for (const [name, v] of [
    ['short', 'a\u0000b'],
    ['in the first piece of a long string', 'y'.repeat(100) + '\u0000' + 'z'.repeat(500)],
    ['at the end of the first piece', 'y'.repeat(254) + '\u0000' + 'z'.repeat(500)],
    ['in the last piece of a long string', 'y'.repeat(500) + '\u0000' + 'z'.repeat(100)],
    ['in every piece', '\u0000'.repeat(1500)],
    ['with characters of several octets', 'é'.repeat(200) + '\u0000' + '€'.repeat(300)],
  ]) {
    test(name, () => {
      db.run('INSERT INTO t (s) VALUES (?)', [v]);
      assert.equal(db.get('SELECT s FROM t').S, v);
    });
  }
});
