'use strict';

// The tests are ported from vsql-python's (which are ported from vsql-go's).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { afterEach, beforeEach, describe, test } = require('node:test');
const { Worker } = require('node:worker_threads');

const vsql = require('..');

// tempPath is the path of a new database file, in a folder that's removed
// after the test.
function tempPath(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vsql-node-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  return path.join(dir, 'test.vsql');
}

function scalar(db, sql, params) {
  return Object.values(db.get(sql, params))[0];
}

function count(file) {
  const other = vsql.connect(file);
  try {
    return scalar(other, 'SELECT COUNT(*) FROM foo');
  } finally {
    other.close();
  }
}

describe('with a connection to a new in-memory database', () => {
  let db;
  beforeEach(() => {
    db = vsql.connect(':memory:');
  });
  afterEach(() => {
    db.close();
  });

  for (const [expr, want, type] of [
    ['CAST(12 AS SMALLINT)', 12, 'SMALLINT'],
    ['CAST(-12 AS INTEGER)', -12, 'INTEGER'],
    ['CAST(9007199254740991 AS BIGINT)', 9007199254740991, 'BIGINT'],
    ['CAST(1.5 AS REAL)', 1.5, 'REAL'],
    ['CAST(1.25 AS DOUBLE PRECISION)', 1.25, 'DOUBLE PRECISION'],
    ['CAST(1.5 AS DECIMAL(10, 3))', '1.500', 'DECIMAL'],
    ['CAST(12 AS NUMERIC(10, 2))', '12.00', 'NUMERIC'],
    ["CAST('ab' AS CHARACTER(4))", 'ab  ', 'CHARACTER'],
    ["CAST('héllo' AS VARCHAR(10))", 'héllo', 'CHARACTER VARYING'],
    ['TRUE', true, 'BOOLEAN'],
    ['FALSE', false, 'BOOLEAN'],
    ["DATE '2022-01-02'", '2022-01-02', 'DATE'],
    ["TIME '15:04:05.123456'", '15:04:05.123456', 'TIME'],
    ["TIME '15:04:05+05:30'", '15:04:05+05:30', 'TIME WITH TIME ZONE'],
    ["TIMESTAMP '2022-01-02 15:04:05.5'", '2022-01-02T15:04:05.5', 'TIMESTAMP'],
    ["TIMESTAMP '2022-01-02 15:04:05.123+05:30'", '2022-01-02T15:04:05.123+05:30',
      'TIMESTAMP WITH TIME ZONE'],
    ['CAST(NULL AS INTEGER)', null, 'INTEGER'],
    ['CAST(NULL AS BOOLEAN)', null, 'BOOLEAN'],
    ['CAST(NULL AS DATE)', null, 'DATE'],
    ['CAST(NULL AS TIMESTAMP WITH TIME ZONE)', null, 'TIMESTAMP WITH TIME ZONE'],
  ]) {
    test(`column value ${expr}`, () => {
      const stmt = db.prepare(`VALUES ${expr}`);
      assert.equal(stmt.columns()[0].type, type);
      assert.deepEqual(stmt.raw().get(), [want]);
      stmt.close();
    });
  }

  test('a timestamp with a time zone can be parsed by Date', () => {
    const ts = scalar(db, "VALUES TIMESTAMP '2022-01-02 15:04:05.123+05:30'");
    assert.equal(new Date(ts).toISOString(), '2022-01-02T09:34:05.123Z');
  });

  test('BIGINT is a number, unless it is out of range', () => {
    assert.throws(() => db.get('VALUES CAST(9223372036854775807 AS BIGINT)'), RangeError);
    assert.equal(scalar(db, 'VALUES CAST(-9007199254740991 AS BIGINT)'), -9007199254740991);
  });

  test('BIGINT is a bigint with { bigint: true }', () => {
    const big = vsql.connect(':memory:', { bigint: true });
    try {
      assert.equal(scalar(big, 'VALUES CAST(9223372036854775807 AS BIGINT)'), 9223372036854775807n);
      assert.equal(scalar(big, 'VALUES CAST(12 AS INTEGER)'), 12);
      assert.equal(scalar(big, 'VALUES CAST(NULL AS BIGINT)'), null);
    } finally {
      big.close();
    }
  });

  test('columns', () => {
    db.run('CREATE TABLE foo (a INTEGER NOT NULL, b VARCHAR(20), c NUMERIC(10, 3))');

    const stmt = db.prepare('SELECT * FROM foo');
    assert.equal(stmt.reader, true);
    assert.deepEqual(stmt.columns(), [
      { name: 'A', type: 'INTEGER', nullable: false, length: null, precision: null, scale: null },
      { name: 'B', type: 'CHARACTER VARYING', nullable: true, length: 20, precision: null,
        scale: null },
      { name: 'C', type: 'NUMERIC', nullable: true, length: null, precision: 10, scale: 3 },
    ]);
    stmt.close();

    // A statement that isn't a query has no columns.
    const del = db.prepare('DELETE FROM foo WHERE a > 100');
    assert.equal(del.reader, false);
    assert.deepEqual(del.columns(), []);
    del.close();
  });

  for (const [column, arg, want] of [
    ['s', 12, 12],
    ['i', -12, -12],
    ['b', 9007199254740991, 9007199254740991],
    ['b', 9223372036854775807n, '9223372036854775807'],
    ['r', 1.5, 1.5],
    ['d', 1.25, 1.25],
    ['n', 7, '7.00000'],
    ['n', 1.5, '1.50000'],
    ['n', vsql.numeric('123'), '123.00000'],
    ['n', vsql.numeric('-1.25'), '-1.25000'],
    ['n', vsql.numeric('+.25'), '0.25000'],
    ['n', vsql.numeric('-0.00005'), '-0.00005'],
    ['n', vsql.numeric('0'), '0.00000'],
    ['n', vsql.numeric(10n ** 14n), '100000000000000.00000'],
    ['n', vsql.numeric(2.5), '2.50000'],
    ['n', vsql.numeric('123456789012345.12345'), '123456789012345.12345'],
    ['c', 'héllo', 'héllo'],
    ['c', '', ''],
    ['c', '😀', '😀'],
    ['bo', true, true],
    ['bo', false, false],
    ['ts', vsql.timestamp('2022-01-02 15:04:05.123456'), '2022-01-02T15:04:05.123456'],
    ['ts', vsql.timestamp('2022-01-02T15:04:05'), '2022-01-02T15:04:05.000000'],
    ['tz', vsql.timestamp('2022-01-02 15:04:05.123456-04:00'), '2022-01-02T15:04:05.123456-04:00'],
    ['tz', vsql.timestamp('2022-01-02T15:04:05.5Z'), '2022-01-02T15:04:05.500000+00:00'],
    ['tz', vsql.timestamp('2022-01-02T15:04:05+0530'), '2022-01-02T15:04:05.000000+05:30'],
    ['tz', new Date(Date.UTC(2022, 0, 2, 15, 4, 5, 123)), '2022-01-02T15:04:05.123000+00:00'],
    ['dt', vsql.date('2022-01-02'), '2022-01-02'],
    ['tm', vsql.time('15:04:05.123456'), '15:04:05.123456'],
    ['tt', vsql.time('15:04:05+05:30'), '15:04:05.000000+05:30'],
    ['i', null, null],
    ['c', undefined, null],
    ['bo', null, null],
    ['dt', null, null],
  ]) {
    test(`parameter ${column} = ${arg}`, () => {
      db.run(`CREATE TABLE foo (
        s SMALLINT, i INTEGER, b BIGINT, r REAL, d DOUBLE PRECISION,
        n NUMERIC(20, 5), c VARCHAR(100), bo BOOLEAN,
        ts TIMESTAMP(6), tz TIMESTAMP(6) WITH TIME ZONE, dt DATE,
        tm TIME(6), tt TIME(6) WITH TIME ZONE)`);
      db.run(`INSERT INTO foo (${column}) VALUES (?)`, [arg]);

      // A BIGINT that's out of the range of a number is read as a string.
      const select = typeof want === 'string' && column === 'b'
        ? `SELECT CAST(${column} AS VARCHAR(30)) FROM foo` : `SELECT ${column} FROM foo`;
      assert.equal(scalar(db, select), want);
    });
  }

  test('a column value can be a parameter', () => {
    db.run('CREATE TABLE foo (n NUMERIC(10, 2), d DATE, t TIME(6), ts TIMESTAMP(6) WITH TIME ZONE)');
    db.run(`INSERT INTO foo (n, d, t, ts) VALUES
      (1.5, DATE '2022-01-02', TIME '15:04:05.25', TIMESTAMP '2022-01-02 15:04:05.5-04:00')`);
    const row = db.get('SELECT * FROM foo');
    db.run('INSERT INTO foo (n, d, t, ts) VALUES (?, ?, ?, ?)',
      [vsql.numeric(row.N), vsql.date(row.D), vsql.time(row.T), vsql.timestamp(row.TS)]);
    assert.deepEqual(db.all('SELECT * FROM foo'), [row, row]);
  });

  test('bigint out of range is NUMERIC', () => {
    assert.equal(scalar(db, 'VALUES CAST(? AS NUMERIC(30))', [10n ** 25n]),
      '10000000000000000000000000');
  });

  test('parameters in WHERE', () => {
    db.run('CREATE TABLE foo (i INTEGER, c VARCHAR(10))');
    db.run('INSERT INTO foo (i, c) VALUES (?, ?)', [1, 'a']);
    db.run('INSERT INTO foo (i, c) VALUES (?, ?)', [2, 'b']);
    assert.equal(scalar(db, 'SELECT c FROM foo WHERE i = ?', [2]), 'b');
  });

  for (const [params, error, message] of [
    [{ i: 1 }, TypeError, /named parameters/],
    ['1', TypeError, /must be an array/],
    [[Buffer.from('bytes')], TypeError, /parameter 1: .*binary/],
    [[{}], TypeError, /unsupported type Object/],
    [[Symbol('x')], TypeError, /unsupported type symbol/],
    [[new Date(NaN)], RangeError, /invalid Date/],
    [[new Date('+010000-01-01')], RangeError, /invalid Date/],
    [[], vsql.VsqlError, /dynamic parameter/],
  ]) {
    test(`parameter error ${message}`, () => {
      assert.throws(() => db.get('VALUES CAST(? AS INTEGER)', params), (e) => {
        assert.ok(e instanceof error, e);
        assert.match(e.message, message);
        return true;
      });
    });
  }

  for (const [fn, arg] of [
    [vsql.numeric, '1e5'],
    [vsql.numeric, '.'],
    [vsql.numeric, NaN],
    [vsql.numeric, null],
    [vsql.date, '2022-1-2'],
    [vsql.time, '15:04'],
    [vsql.time, '15:04:05.1234567'],
    [vsql.timestamp, '2022-01-02'],
    [vsql.timestamp, new Date()],
  ]) {
    test(`${fn.name}(${String(arg)}) is a RangeError`, () => {
      assert.throws(() => fn(arg), RangeError);
    });
  }

  test('long strings', () => {
    db.run('CREATE TABLE foo (s VARCHAR(10000))');
    for (const n of [255, 256, 257, 1000, 9999]) {
      // Multi-byte characters cross the boundary of each piece that
      // SQLGetData reads.
      const want = 'é'.repeat(Math.floor(n / 2)) + 'x'.repeat(n % 2);
      db.run('DELETE FROM foo');
      db.run('INSERT INTO foo (s) VALUES (?)', [want]);
      assert.equal(scalar(db, 'SELECT s FROM foo'), want);
    }
  });

  for (const [sql, sqlstate] of [
    ['SELECT * FROM nope', '42P01'],
    ['SELEC 1', '42601'],
    // Transactions are ended with commit and rollback.
    ['COMMIT', '42000'],
    ['VALUES 1 / 0', '22012'],
  ]) {
    test(`error ${sql}`, () => {
      assert.throws(() => db.all(sql), (e) => {
        assert.ok(e instanceof vsql.VsqlError);
        assert.equal(e.name, 'VsqlError');
        assert.equal(e.sqlstate, sqlstate);
        assert.equal(e.code, sqlstate);
        assert.match(e.message, new RegExp(`\\(SQLSTATE ${sqlstate}\\)$`));
        return true;
      });

      // The connection still works after an error.
      assert.equal(scalar(db, 'VALUES 1'), 1);
    });
  }

  test('integrity error', () => {
    db.run('CREATE TABLE foo (x INTEGER NOT NULL)');
    assert.throws(() => db.run('INSERT INTO foo (x) VALUES (NULL)'), (e) => {
      assert.match(e.sqlstate, /^23/);
      return true;
    });
  });

  test('changes', () => {
    db.run('CREATE TABLE foo (x INTEGER)');
    db.run('INSERT INTO foo (x) VALUES (1)');
    db.run('INSERT INTO foo (x) VALUES (2)');

    assert.deepEqual(db.run('UPDATE foo SET x = x + 1'), { changes: 2 });
    assert.deepEqual(db.run('SELECT * FROM foo'), { changes: 0 });
    assert.deepEqual(db.run('DELETE FROM foo WHERE x > 100'), { changes: 0 });
  });

  test('get, all and iterate', () => {
    db.run('CREATE TABLE foo (x INTEGER)');
    const insert = db.prepare('INSERT INTO foo (x) VALUES (?)');
    for (let i = 0; i < 10; i++) {
      insert.run([i]);
    }
    insert.close();

    const stmt = db.prepare('SELECT x FROM foo WHERE x >= ?');
    assert.deepEqual(stmt.get([3]), { X: 3 });
    assert.equal(stmt.get([100]), undefined);
    assert.deepEqual(stmt.all([7]), [{ X: 7 }, { X: 8 }, { X: 9 }]);
    assert.deepEqual(stmt.all([100]), []);
    assert.deepEqual([...stmt.iterate([5])].map((r) => r.X), [5, 6, 7, 8, 9]);
    assert.deepEqual(stmt.raw().all([8]), [[8], [9]]);
    assert.deepEqual(stmt.raw(false).all([9]), [{ X: 9 }]);

    // Leaving the loop closes the rows, so the statement can be executed
    // again.
    for (const row of stmt.iterate([0])) {
      if (row.X === 2) {
        break;
      }
    }
    assert.deepEqual(stmt.get([9]), { X: 9 });

    // It can't be executed while it's being iterated.
    const rows = stmt.iterate([0]);
    assert.deepEqual(rows.next().value, { X: 0 });
    assert.throws(() => stmt.all([0]), /being iterated/);
    rows.return();
    assert.equal(stmt.all([0]).length, 10);
    stmt.close();

    assert.deepEqual([...db.iterate('SELECT x FROM foo WHERE x < ?', [2])], [{ X: 0 }, { X: 1 }]);

    // get, all and iterate are for queries (but it's only known once the
    // statement has been executed).
    assert.throws(() => db.get('DELETE FROM foo WHERE x > 100'), /use run/);
    assert.equal(scalar(db, 'SELECT COUNT(*) FROM foo'), 10);

    // A query from a table that doesn't exist yet only has columns once it's
    // executed.
    const later = db.prepare('SELECT * FROM bar');
    db.run('CREATE TABLE bar (y INTEGER)');
    db.run('INSERT INTO bar (y) VALUES (1)');
    assert.deepEqual(later.all(), [{ Y: 1 }]);
    assert.equal(later.reader, true);
    later.close();
  });

  test('columns with the same name', () => {
    assert.deepEqual(db.get('VALUES ROW(1, 2)'), { COL1: 1, COL2: 2 });
    db.run('CREATE TABLE foo (x INTEGER)');
    db.run('INSERT INTO foo (x) VALUES (1)');
    assert.deepEqual(db.prepare('SELECT x, x + 1 AS x FROM foo').raw().get(), [1, 2]);
  });

  test('prepared statements', () => {
    db.run('CREATE TABLE foo (x INTEGER)');
    const insert = db.prepare('INSERT INTO foo (x) VALUES (?)');
    assert.equal(insert.sql, 'INSERT INTO foo (x) VALUES (?)');
    for (let i = 1; i <= 10; i++) {
      insert.run([i]);
    }

    // Each statement has its own rows, so the rows of one are still open
    // while another is executed.
    const rows1 = db.iterate('SELECT x FROM foo WHERE x > ?', [5]);
    const rows2 = db.iterate('SELECT x FROM foo WHERE x > ?', [8]);
    assert.equal([...rows2].length, 2);
    assert.equal([...rows1].length, 5);

    assert.throws(() => db.prepare('SELEC ?'), vsql.VsqlError);
    assert.throws(() => db.prepare(1), TypeError);
  });

  test('statement close', () => {
    const stmt = db.prepare('VALUES 1');
    stmt.get();
    stmt.close();
    stmt.close();
    assert.throws(() => stmt.get(), /statement is closed/);

    // Statements and connections can be declared with "using" (which is
    // Symbol.dispose) from Node 24.
    const s = db.prepare('VALUES 1');
    s[Symbol.dispose]();
    assert.throws(() => s.get(), /statement is closed/);
  });
});

test('connection close', (t) => {
  const db = vsql.connect(tempPath(t));
  const stmt = db.prepare('VALUES 1');
  const rows = db.iterate('VALUES 1');
  assert.equal(db.open, true);
  db.close();
  db.close();
  assert.equal(db.open, false);
  assert.throws(() => db.prepare('VALUES 1'), /connection is closed/);
  assert.throws(() => db.all('VALUES 1'), /connection is closed/);
  assert.throws(() => stmt.get(), /connection is closed/);
  assert.throws(() => db.begin(), /connection is closed/);
  assert.throws(() => db.commit(), /connection is closed/);
  assert.deepEqual([...rows], []);
  stmt.close();

  assert.throws(() => vsql.connect(1), TypeError);
});

test('Symbol.dispose closes the connection', (t) => {
  const db = vsql.connect(tempPath(t));
  db[Symbol.dispose]();
  assert.equal(db.open, false);
});

test('transactions', (t) => {
  const file = tempPath(t);
  const setup = vsql.connect(file);
  setup.run('CREATE TABLE foo (x INTEGER)');
  setup.close();

  let db = vsql.connect(file);
  assert.equal(db.inTransaction, false);

  // Without a transaction, each statement is committed.
  db.run('INSERT INTO foo (x) VALUES (1)');
  assert.equal(count(file), 1);

  // commit
  db.begin();
  assert.equal(db.inTransaction, true);
  assert.throws(() => db.begin(), /already a transaction/);
  db.run('INSERT INTO foo (x) VALUES (2)');
  assert.equal(count(file), 1);
  db.commit();
  assert.equal(db.inTransaction, false);
  assert.equal(count(file), 2);

  // rollback
  db.begin();
  db.run('INSERT INTO foo (x) VALUES (3)');
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM foo'), 3);
  db.rollback();
  assert.equal(count(file), 2);

  // Commit and rollback without a transaction do nothing.
  db.commit();
  db.rollback();

  // transaction commits, or rolls back if the function throws.
  assert.equal(db.transaction(() => {
    db.run('INSERT INTO foo (x) VALUES (4)');
    return 'done';
  }), 'done');
  assert.equal(count(file), 3);
  assert.throws(() => db.transaction(() => {
    db.run('INSERT INTO foo (x) VALUES (5)');
    throw new Error('oops');
  }), /oops/);
  assert.equal(db.inTransaction, false);
  assert.equal(count(file), 3);
  assert.throws(() => db.transaction(async () => {}), /can't be async/);
  assert.equal(db.inTransaction, false);

  // Closing the connection rolls back the transaction.
  db.begin();
  db.run('INSERT INTO foo (x) VALUES (6)');
  db.close();
  assert.equal(count(file), 3);

  // Ending a transaction finishes its iterators.
  db = vsql.connect(file);
  db.begin();
  const stmt = db.prepare('SELECT x FROM foo');
  const rows = stmt.iterate();
  assert.notEqual(rows.next().value, undefined);
  db.commit();
  assert.equal(rows.next().done, true);
  assert.equal(stmt.all().length, 3);
  db.close();
});

test('persistence', (t) => {
  const file = tempPath(t);
  let db = vsql.connect(file);
  db.run('CREATE TABLE foo (x VARCHAR(10))');
  db.run("INSERT INTO foo (x) VALUES ('saved')");
  db.close();

  db = vsql.connect(file);
  assert.equal(scalar(db, 'SELECT x FROM foo'), 'saved');
  db.close();
});

test('memory databases are separate', () => {
  const a = vsql.connect(':memory:');
  const b = vsql.connect(':memory:');
  a.run('CREATE TABLE foo (x INTEGER)');
  assert.throws(() => b.all('SELECT * FROM foo'), vsql.VsqlError);
  a.close();
  b.close();
});

test('statements and connections that are not closed are freed', async () => {
  const db = vsql.connect(':memory:');
  for (let i = 0; i < 1000; i++) {
    db.prepare('VALUES ?').get([i]);
  }
  for (let i = 0; i < 100; i++) {
    vsql.connect(':memory:').get('VALUES 1');
  }
  if (global.gc) {
    global.gc();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(scalar(db, 'VALUES 1'), 1);
  db.close();
});

test('concurrency', async (t) => {
  // Many connections from many worker threads, with enough work for the
  // garbage collector to run.
  const file = tempPath(t);
  const setup = vsql.connect(file);
  setup.run('CREATE TABLE foo (g INTEGER, x INTEGER)');
  setup.close();

  const workers = 8;
  const inserts = 50;
  const worker = `
    const { workerData: { file, g, inserts } } = require('node:worker_threads');
    const vsql = require(${JSON.stringify(path.join(__dirname, '..'))});
    const db = vsql.connect(file);
    for (let i = 0; i < inserts; i++) {
      db.run('INSERT INTO foo (g, x) VALUES (?, ?)', [g, i]);
      const n = Object.values(db.get('SELECT COUNT(*) FROM foo WHERE g = ?', [g]))[0];
      if (n !== i + 1) {
        throw new Error('worker ' + g + ': got ' + n + ' rows, want ' + (i + 1));
      }
    }
    db.close();
  `;
  await Promise.all(Array.from({ length: workers }, (_, g) => new Promise((resolve, reject) => {
    const w = new Worker(worker, { eval: true, workerData: { file, g, inserts } });
    w.on('error', reject);
    w.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`exit code ${code}`))));
  })));

  assert.equal(count(file), workers * inserts);
});
