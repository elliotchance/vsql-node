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
    ["CAST('1.5E+400' AS DECFLOAT)", '1.5E+400', 'DECFLOAT'],
    ['CAST(1 AS DECFLOAT) / 3', '0.3333333333333333333333333333333333', 'DECFLOAT'],
    ["X'DEADBEEF'", Buffer.from('deadbeef', 'hex'), 'BINARY'],
    ["CAST(X'00FF' AS BINARY(4))", Buffer.from('00ff0000', 'hex'), 'BINARY'],
    ["CAST(X'' AS VARBINARY(4))", Buffer.alloc(0), 'BINARY VARYING'],
    ["CAST(X'01' AS BLOB)", Buffer.from([1]), 'BINARY LARGE OBJECT'],
    ["CAST('héllo' AS CLOB)", 'héllo', 'CHARACTER LARGE OBJECT'],
    ["INTERVAL '1-02' YEAR TO MONTH", '1-02', 'INTERVAL YEAR TO MONTH'],
    ["INTERVAL -'1-02' YEAR TO MONTH", '-1-02', 'INTERVAL YEAR TO MONTH'],
    ["INTERVAL '5' DAY", '5', 'INTERVAL DAY'],
    ["INTERVAL '3 04:05:06.5' DAY TO SECOND", '3 04:05:06.500000', 'INTERVAL DAY TO SECOND'],
    ["INTERVAL '04:05' MINUTE TO SECOND", '4:05.000000', 'INTERVAL MINUTE TO SECOND'],
    ['CAST(NULL AS INTEGER)', null, 'INTEGER'],
    ['CAST(NULL AS VARBINARY(4))', null, 'BINARY VARYING'],
    ['CAST(NULL AS INTERVAL YEAR)', null, 'INTERVAL YEAR'],
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
      { name: 'A', type: 'INTEGER', nullable: false, length: null, precision: null, scale: null,
        key: null },
      { name: 'B', type: 'CHARACTER VARYING', nullable: true, length: 20, precision: null,
        scale: null, key: null },
      { name: 'C', type: 'NUMERIC', nullable: true, length: null, precision: 10, scale: 3,
        key: null },
    ]);
    stmt.close();

    // A statement that isn't a query has no columns.
    const del = db.prepare('DELETE FROM foo WHERE a > 100');
    assert.equal(del.reader, false);
    assert.deepEqual(del.columns(), []);
    del.close();
  });

  test('columns of the new types', () => {
    db.run(`CREATE TABLE foo (b BINARY(4), vb VARBINARY(10), bl BLOB, cl CLOB, d DECFLOAT(16),
      ym INTERVAL YEAR(3) TO MONTH, ds INTERVAL DAY TO SECOND(2))`);
    const col = (name, type, length, precision, scale) =>
      ({ name, type, nullable: true, length, precision, scale, key: null });
    assert.deepEqual(db.prepare('SELECT * FROM foo').columns(), [
      col('B', 'BINARY', 4, null, null),
      col('VB', 'BINARY VARYING', 10, null, null),
      col('BL', 'BINARY LARGE OBJECT', null, null, null),
      col('CL', 'CHARACTER LARGE OBJECT', null, null, null),
      col('D', 'DECFLOAT', null, 16, null),
      // The precision of an interval is its leading field precision, and the
      // scale is its fractional seconds precision.
      col('YM', 'INTERVAL YEAR TO MONTH', null, 3, null),
      col('DS', 'INTERVAL DAY TO SECOND', null, 2, 2),
    ]);
  });

  test('columns of a key', () => {
    db.run('CREATE TABLE foo (a INTEGER, b INTEGER, c INTEGER, PRIMARY KEY (a, b))');
    db.run('CREATE TABLE bar (a INTEGER NOT NULL UNIQUE, b INTEGER)');
    const keys = (sql) => db.prepare(sql).columns().map((c) => c.key);
    assert.deepEqual(keys('SELECT c, b, a FROM foo'), [null, 'PRIMARY', 'PRIMARY']);
    assert.deepEqual(keys('SELECT b, a FROM bar'), [null, 'PREFERRED']);

    // A key that isn't all in the rows isn't a key of the rows.
    assert.deepEqual(keys('SELECT c, a FROM foo'), [null, null]);
  });

  test('parameters', () => {
    db.run(`CREATE TABLE foo (i INTEGER NOT NULL, c VARCHAR(20), n NUMERIC(10, 2), dt DATE,
      vb VARBINARY(8), d DECFLOAT, ds INTERVAL DAY(3) TO SECOND(2))`);
    const p = (type, length, precision, scale) =>
      ({ type, nullable: true, length, precision, scale });
    const stmt = db.prepare(`SELECT * FROM foo
      WHERE i = ? AND c = ? AND n = ? AND dt = ? AND vb = ? AND d = ? AND ds = ?`);
    assert.deepEqual(stmt.parameters(), [
      p('INTEGER', null, null, null),
      p('CHARACTER VARYING', 20, null, null),
      p('NUMERIC', null, 10, 2),
      p('DATE', null, null, null),
      p('BINARY VARYING', 8, null, null),
      p('DECFLOAT', null, 34, null),
      p('INTERVAL DAY TO SECOND', null, 3, 2),
    ]);
    stmt.close();
    assert.deepEqual(db.prepare('VALUES 1').parameters(), []);
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
    ['bi', Buffer.from('hi'), Buffer.from('hi\0\0', 'latin1')],
    ['vb', Buffer.from([0, 1, 255]), Buffer.from([0, 1, 255])],
    ['vb', new Uint8Array([1, 2]), Buffer.from([1, 2])],
    ['vb', new Uint16Array([0x0201]), Buffer.from([1, 2])],
    ['vb', new Uint8Array([9, 8]).buffer, Buffer.from([9, 8])],
    ['vb', new DataView(new Uint8Array([1, 2, 3]).buffer, 1), Buffer.from([2, 3])],
    ['vb', Buffer.alloc(0), Buffer.alloc(0)],
    ['bl', Buffer.alloc(1000, 7), Buffer.alloc(1000, 7)],
    ['cl', 'é'.repeat(300), 'é'.repeat(300)],
    ['df', '1.5E+400', '1.5E+400'],
    ['df', 0.1, '0.1'],
    ['df', vsql.numeric('-12.50'), '-12.50'],
    ['ym', '-1-2', '-1-02'],
    ['ym', '5-11', '5-11'],
    ['dts', '123 4:05:06.25', '123 04:05:06.250000'],
    // A string is cast to the type of the parameter.
    ['n', '-12.5', '-12.50000'],
    ['dt', '2022-01-02', '2022-01-02'],
    ['i', null, null],
    ['c', undefined, null],
    ['vb', null, null],
    ['bo', null, null],
    ['dt', null, null],
  ]) {
    test(`parameter ${column} = ${arg}`, () => {
      db.run(`CREATE TABLE foo (
        s SMALLINT, i INTEGER, b BIGINT, r REAL, d DOUBLE PRECISION,
        n NUMERIC(20, 5), c VARCHAR(100), bo BOOLEAN,
        ts TIMESTAMP(6), tz TIMESTAMP(6) WITH TIME ZONE, dt DATE,
        tm TIME(6), tt TIME(6) WITH TIME ZONE, bi BINARY(4), vb VARBINARY(1000),
        bl BLOB, cl CLOB, df DECFLOAT, ym INTERVAL YEAR TO MONTH,
        dts INTERVAL DAY(3) TO SECOND(6))`);
      db.run(`INSERT INTO foo (${column}) VALUES (?)`, [arg]);

      // A BIGINT that's out of the range of a number is read as a string.
      const select = typeof want === 'string' && column === 'b'
        ? `SELECT CAST(${column} AS VARCHAR(30)) FROM foo` : `SELECT ${column} FROM foo`;
      assert.deepEqual(scalar(db, select), want);
    });
  }

  test('a column value can be a parameter', () => {
    db.run(`CREATE TABLE foo (n NUMERIC(10, 2), d DATE, t TIME(6), ts TIMESTAMP(6) WITH TIME ZONE,
      vb VARBINARY(4), df DECFLOAT, ym INTERVAL YEAR TO MONTH, ds INTERVAL DAY TO SECOND)`);
    db.run(`INSERT INTO foo (n, d, t, ts, vb, df, ym, ds) VALUES
      (1.5, DATE '2022-01-02', TIME '15:04:05.25', TIMESTAMP '2022-01-02 15:04:05.5-04:00',
       X'00FF', CAST('1.5E+400' AS DECFLOAT), INTERVAL -'1-02' YEAR TO MONTH,
       INTERVAL '3 04:05:06.5' DAY TO SECOND)`);
    const row = db.get('SELECT * FROM foo');
    db.run('INSERT INTO foo (n, d, t, ts, vb, df, ym, ds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [vsql.numeric(row.N), vsql.date(row.D), vsql.time(row.T), vsql.timestamp(row.TS), row.VB,
        row.DF, row.YM, row.DS]);
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
    [[Buffer.from('bytes')], vsql.VsqlError, /restricted data type/],
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

  for (const [sql, sqlstate, fields] of [
    ['INSERT INTO foo (id, x) VALUES (1, 1)', '23505', {
      constraintCatalog: ':memory:', constraintSchema: 'PUBLIC', constraintName: 'FOO_PRIMARY_KEY',
      catalogName: ':memory:', schemaName: 'PUBLIC', tableName: 'FOO',
    }],
    ['INSERT INTO foo (id, x) VALUES (2, -1)', '23514', {
      constraintCatalog: ':memory:', constraintSchema: 'PUBLIC', constraintName: 'POSITIVE',
      catalogName: ':memory:', schemaName: 'PUBLIC', tableName: 'FOO',
    }],
    ['INSERT INTO bar (id) VALUES (5)', '23503', {
      constraintCatalog: ':memory:', constraintSchema: 'PUBLIC', constraintName: 'FK_FOO',
      catalogName: ':memory:', schemaName: 'PUBLIC', tableName: 'BAR',
    }],
    ['SELECT * FROM nope', '42P01', {
      catalogName: ':memory:', schemaName: 'PUBLIC', tableName: 'NOPE',
    }],
    ['SELECT nope FROM foo', '42601', { columnName: 'NOPE' }],
  ]) {
    test(`error fields ${sql}`, () => {
      db.run('CREATE TABLE foo (id INTEGER PRIMARY KEY, x INTEGER CONSTRAINT positive CHECK (x > 0))');
      db.run('CREATE TABLE bar (id INTEGER CONSTRAINT fk_foo REFERENCES foo (id))');
      db.run('INSERT INTO foo (id, x) VALUES (1, 1)');
      assert.throws(() => db.run(sql), (e) => {
        assert.ok(e instanceof vsql.VsqlError);
        assert.equal(e.sqlstate, sqlstate);
        const got = {};
        for (const name of ['constraintCatalog', 'constraintSchema', 'constraintName',
          'catalogName', 'schemaName', 'tableName', 'columnName', 'cursorName']) {
          if (name in e) {
            got[name] = e[name];
          }
        }
        assert.deepEqual(got, fields);
        assert.equal(e.more, false);
        return true;
      });
    });
  }

  test('info', () => {
    const info = db.info();
    assert.equal(info.dbmsName, 'vsql');
    assert.match(info.dbmsVersion, /^\d{2}\.\d{2}\.\d{4}$/);
    assert.match(info.buildVersion, /^(v\d+\.\d+\.\d+)?$/);
    assert.match(info.buildDate, /^\d{4}-\d{2}-\d{2}$/);
    for (const name of ['buildCommit', 'buildVVersion', 'buildVCommit', 'buildCCompiler',
      'operatingSystem', 'machine']) {
      assert.equal(typeof info[name], 'string', name);
    }
    // A database in memory doesn't have a file format.
    assert.equal(info.fileReadVersion, 0);
    assert.equal(info.fileWriteVersion, 0);
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

    // A query from a table that doesn't exist can't be prepared.
    assert.throws(() => db.prepare('SELECT * FROM bar'), { sqlstate: '42P01' });
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

test('nested transactions use savepoints', (t) => {
  const file = tempPath(t);
  const db = vsql.connect(file);
  db.run('CREATE TABLE foo (x INTEGER)');
  const xs = () => db.all('SELECT x FROM foo ORDER BY x').map((r) => r.X);

  db.transaction(() => {
    db.run('INSERT INTO foo (x) VALUES (1)');

    // Only what the inner transaction did is rolled back.
    assert.throws(() => db.transaction(() => {
      db.run('INSERT INTO foo (x) VALUES (2)');
      throw new Error('inner');
    }), /inner/);
    assert.equal(db.inTransaction, true);
    assert.deepEqual(xs(), [1]);

    // A statement that fails in the inner transaction is rolled back too.
    assert.throws(() => db.transaction(() => {
      db.run('INSERT INTO foo (x) VALUES (3)');
      db.run('INSERT INTO foo (x) VALUES (1 / 0)');
    }), vsql.VsqlError);
    assert.deepEqual(xs(), [1]);

    assert.equal(db.transaction(() => db.transaction(() => {
      db.run('INSERT INTO foo (x) VALUES (4)');
      return 'deep';
    })), 'deep');
    assert.throws(() => db.transaction(() => {}, { readOnly: true }), /can't have options/);
  });
  assert.equal(db.inTransaction, false);
  assert.deepEqual(xs(), [1, 4]);
  assert.equal(count(file), 2);

  // The outer transaction still rolls back what the inner ones committed.
  assert.throws(() => db.transaction(() => {
    db.transaction(() => db.run('INSERT INTO foo (x) VALUES (5)'));
    throw new Error('outer');
  }), /outer/);
  assert.deepEqual(xs(), [1, 4]);
  db.close();
});

test('rollback to a savepoint', (t) => {
  const db = vsql.connect(tempPath(t));
  db.run('CREATE TABLE foo (x INTEGER)');
  db.begin();
  db.run('INSERT INTO foo (x) VALUES (1)');
  db.run('SAVEPOINT a');
  db.run('INSERT INTO foo (x) VALUES (2)');
  db.run('SAVEPOINT "b c"');
  db.run('INSERT INTO foo (x) VALUES (3)');
  db.rollback('"b c"');
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM foo'), 2);
  db.rollback('a');
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM foo'), 1);
  db.run('RELEASE SAVEPOINT a');
  assert.throws(() => db.rollback('a'), (e) => e.sqlstate === '3B001');
  assert.throws(() => db.rollback(1), TypeError);
  assert.equal(db.inTransaction, true);
  db.commit();
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM foo'), 1);
  db.close();
});

test('transaction options', (t) => {
  const db = vsql.connect(tempPath(t));
  db.run('CREATE TABLE foo (x INTEGER)');

  assert.throws(() => db.transaction(() => db.run('INSERT INTO foo (x) VALUES (1)'),
    { readOnly: true }), (e) => e.sqlstate === '25006');
  assert.equal(db.inTransaction, false);
  assert.deepEqual(db.transaction(() => db.all('SELECT * FROM foo'), { readOnly: true }), []);

  for (const isolationLevel of ['READ COMMITTED', 'REPEATABLE READ', 'SERIALIZABLE']) {
    db.begin({ isolationLevel });
    db.run('INSERT INTO foo (x) VALUES (1)');
    db.commit();
  }
  assert.equal(scalar(db, 'SELECT COUNT(*) FROM foo'), 3);

  // READ UNCOMMITTED must be READ ONLY.
  db.begin({ readOnly: true, isolationLevel: 'READ UNCOMMITTED' });
  db.rollback();
  assert.throws(() => db.begin({ isolationLevel: 'READ UNCOMMITTED' }),
    (e) => e.sqlstate === '42601');
  assert.throws(() => db.begin({ isolationLevel: 'read committed' }), RangeError);
  assert.equal(db.inTransaction, false);
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
    db.prepare('VALUES CAST(? AS INTEGER)').get([i]);
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
