'use strict';

// These tests make each call of the addon (to malloc, Node-API and libvsql)
// fail in turn, which needs the addon that scripts/coverage.sh compiles with
// test/fault.h. Each failure must be an error (or be ignored), and never crash
// or leave the addon unusable.

const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const vsql = require('..');
const lib = require('../lib/binding');

const skip = process.env.VSQL_NODE_COVERAGE ? false : 'needs scripts/coverage.sh';

// withFaults runs fn (which can be async) with each call failing in turn (the
// first, then the second, and so on), until it runs without reaching the call
// that fails. It returns the number of runs.
async function withFaults(name, fn) {
  // Warnings would be printed for each run.
  const emitWarning = process.emitWarning;
  process.emitWarning = () => {};
  try {
    for (let n = 1; ; n++) {
      delete process.env.VSQL_NODE_FAULTED;
      process.env.VSQL_NODE_FAULT = `${name}:${n}`;
      try {
        await fn();
      } catch {
        // Any error is expected.
      } finally {
        delete process.env.VSQL_NODE_FAULT;
      }
      if (process.env.VSQL_NODE_FAULTED === undefined) {
        return n;
      }
    }
  } finally {
    delete process.env.VSQL_NODE_FAULTED;
    process.emitWarning = emitWarning;
  }
}

// collect runs the garbage collector, and the finalizers that it queues.
async function collect() {
  await new Promise((resolve) => setImmediate(resolve));
  global.gc();
  await new Promise((resolve) => setImmediate(resolve));
}

// A value of each type, with long values that are read in pieces.
const long = 'x'.repeat(300) + 'é'.repeat(300);
const octets = Buffer.alloc(600, 7);

function queries(options) {
  const db = vsql.connect(':memory:', { ...options, lockTimeout: 1000 });
  try {
    db.run(`CREATE TABLE t (a INTEGER, b BIGINT, c DOUBLE PRECISION, d REAL,
      e BOOLEAN, f VARCHAR(1000), g VARBINARY(1000), h DATE, i NUMERIC(10, 2),
      PRIMARY KEY (a))`);
    const insert = db.prepare('INSERT INTO t (a, b, c, d, e, f, g, h, i) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    insert.parameters();
    insert.run([1, 2n, 1.5, 2.5, true, long, octets, vsql.date('2024-01-02'), vsql.numeric('1.25')]);
    insert.run([2, 3, 0, 0, false, '', new Uint8Array(0), null, null]);
    insert.run([3, null, null, null, null, null, null, null, null]);
    insert.close();

    const select = db.prepare('SELECT * FROM t ORDER BY a');
    select.columns();
    select.all();
    select.raw().get();
    for (const row of select.iterate()) {
      assert.ok(row);
    }
    select.close();

    db.transaction(() => {
      db.run('UPDATE t SET a = a + 10');
      db.transaction(() => db.run('DELETE FROM t WHERE a = 11'));
      db.savepoint('s');
      db.run('DELETE FROM t');
      db.rollback('s');
      db.release('s');
    });

    // An error, with its diagnostics, and a warning.
    assert.throws(() => db.run('INSERT INTO t (a) VALUES (12)'), vsql.VsqlError);
    db.all('SELECT SUM(b) FROM t');
    db.info();
  } finally {
    db.close();
  }
}

// errors are the errors that the other queries don't raise.
function errors() {
  const db = vsql.connect(':memory:');
  try {
    // An error that libvsql doesn't have a diagnostic record for.
    try {
      lib.freeHandle(lib.SQL_HANDLE_STMT, 99999);
    } catch {
      // It's expected.
    }

    // An error with more conditions than fit.
    db.run('SET SESSION CHARACTERISTICS AS TRANSACTION DIAGNOSTICS SIZE 1');
    db.all('SELECT SUM(x) / 0 FROM (VALUES CAST(NULL AS INT), 1) AS t (x)');
  } finally {
    db.close();
  }
}

describe('faults', { skip }, () => {
  test('each call in queries fails', async () => {
    assert.ok(await withFaults('queries', () => queries()) > 100);
    assert.ok(await withFaults('bigint', () => queries({ bigint: true })) > 100);
    assert.ok(await withFaults('errors', errors) > 10);

    // The addon still works.
    queries();
  });

  // The connections and statements that weren't closed are closed when they're
  // garbage collected, which ignores errors.
  test('each call in freeing a connection fails', async () => {
    assert.ok(await withFaults('collect', async () => {
      (() => {
        const db = vsql.connect(':memory:');
        db.prepare('VALUES 1').all();
        db.prepare('VALUES 2');
        db.begin();
      })();
      await collect();
    }) > 3);
  });
});
