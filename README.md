# vsql-node

A Node.js driver for [vsql](https://github.com/elliotchance/vsql), a single
file or in-memory SQL database. libvsql (the vsql library) is compiled into the
package, so there's nothing else to install.

```sh
npm install vsql-node
```

```js
const vsql = require('vsql-node');

const db = vsql.connect('test.vsql');
db.run('CREATE TABLE foo (x INTEGER)');
db.run('INSERT INTO foo (x) VALUES (?)', [123]);
console.log(db.all('SELECT x FROM foo')); // [ { X: 123 } ]
db.close();
```

The database is the path of the file (it's created if it doesn't exist), or
`:memory:` for a database that only exists for the life of the connection.

`vsql.connect(database, options)` takes these options:

| Option               | Default          |                                                      |
|----------------------|------------------|------------------------------------------------------|
| `bigint`             | `false`          | A `BIGINT` column is a `bigint` (see [Columns](#columns)) |
| `lockTimeout`        | `5000`           | How long (in milliseconds) a `SERIALIZABLE` statement or transaction waits for the other connections to the file, before `40001` (`0` fails straight away, see [API](#api)) |
| `isolationLevel`     | `"SERIALIZABLE"` | The isolation level of a statement outside of a transaction (see [Transactions](#transactions)) |
| `createIndexTimeout` | `60000`          | How long (in milliseconds) `CREATE INDEX` waits for the transactions that changed the table, before `55P03` |
| `cacheSize`          | `2000`           | The number of pages of the file that are kept in memory |
| `pageSize`           | `4096`           | The size of a page (17 to 65535 octets), only for `:memory:` and a new file |
| `fullFsync`          | `false`          | Sync with `F_FULLFSYNC` on macOS (it does nothing elsewhere), so that commits survive a power failure |

See [example/main.js](example/main.js) for a complete program:

```sh
node example/main.js
```

## API

The API is synchronous: each call runs vsql on the calling thread, and returns
when it's finished (like `node:sqlite` and better-sqlite3). To run queries at
the same time, use a connection in each
[worker thread](https://nodejs.org/api/worker_threads.html).

This includes waiting for a lock: a `SERIALIZABLE` statement or transaction
(see [Transactions](#transactions)) waits up to 5 seconds for the other
connections to the file to finish their transactions, and the event loop is
blocked while it waits. If the other connection is on the same thread, it
can't finish, so the wait always fails with `40001` after 5 seconds. To fail
straight away instead, connect with `{ lockTimeout: 0 }` (and retry later), or
with `{ isolationLevel: 'READ COMMITTED' }`, which doesn't wait.

Each call is one statement. More than one (`INSERT ...; INSERT ...`) is a
syntax error (`42601`), although a `;` at the end is allowed. A `--` comment
is an error (`42000`), so use `/* ... */` instead.

| Connection                      | Statement                 |                                                     |
|---------------------------------|---------------------------|-----------------------------------------------------|
| `db.prepare(sql)`               |                           | Prepares a statement                                |
| `db.run(sql, params)`           | `stmt.run(params)`        | Executes a statement, returns `{ changes }`         |
| `db.get(sql, params)`           | `stmt.get(params)`        | The first row of a query, or `undefined`            |
| `db.all(sql, params)`           | `stmt.all(params)`        | All the rows of a query                             |
| `db.iterate(sql, params)`       | `stmt.iterate(params)`    | An iterator of the rows, fetched one at a time      |
|                                 | `stmt.columns()`          | The name, type, nullability, length, precision, scale and key of each column |
|                                 | `stmt.parameters()`       | The type, nullability, length, precision and scale of each `?` |
|                                 | `stmt.raw()`              | Each row is an array instead of an object           |
| `db.info()`                     |                           | The version of vsql, and the file format of the database |
| `db.close()`                    | `stmt.close()`            | Frees the connection or statement                   |

Each row is an object keyed by the column names, which vsql uppercases unless
they're quoted (`SELECT x` is `{ X: ... }`). Use `stmt.raw()` when columns have
the same name.

The `length` of a column is the maximum length of a `CHARACTER` or
`CHARACTER VARYING` (in characters) or a `BINARY` or `BINARY VARYING` (in
octets). The `precision` and `scale` are those of a `DECIMAL` or `NUMERIC` (or
the `precision` of a `DECFLOAT`), or the leading field precision and fractional
seconds precision of an interval. The `precision` of a `TIME` or `TIMESTAMP`
(with or without a time zone) is its fractional seconds precision (6 for a
`TIMESTAMP` and 0 for a `TIME`, unless it's given). The others are `null`. When vsql knows the key
of the rows (such as when they're all the columns of a `PRIMARY KEY`), each of
its columns has a `key` of `"PRIMARY"` (or `"PREFERRED"` for a key that isn't
the primary key, such as a `UNIQUE NOT NULL` column).

The columns are checked each time a statement is executed, so a prepared
statement follows a table that was replaced or altered after it was prepared
(the rows and `stmt.columns()` have the new names and types).

`stmt.parameters()` describes each `?` with the type that vsql works out from
where it's used (such as the type of `x` in `x = ?`):

```js
db.prepare('SELECT * FROM foo WHERE x = ?').parameters();
// [ { type: 'INTEGER', nullable: true, length: null, precision: null, scale: null } ]
```

`db.info()` is the version of vsql (such as `buildVersion: "v1.7.58"`), how it
was built, and the file format versions of the database:

```js
db.info();
// { dbmsName: 'vsql', dbmsVersion: '01.07.0058', buildVersion: 'v1.7.58',
//   buildCommit: '3cafbc3...', buildDate: '2026-11-26', buildVVersion: '0.5.2',
//   buildVCommit: 'c0bb949', buildCCompiler: 'clang', operatingSystem: 'macos',
//   machine: 'arm64', fileReadVersion: 0, fileWriteVersion: 0 }
```

A statement that hasn't been closed is freed when it's garbage collected
(closing its rows, if an iterator was left part way through), as is a connection
(which rolls back its transaction). Both can be declared with
`using` (on Node 24 or later).

## Transactions

Each statement is committed when it finishes, or when all the rows of a query
have been fetched (or the iterator is left). `db.iterate()` only executes the
query when its iterator is first advanced. `db.begin()` starts a transaction,
which is ended by `db.commit()` or `db.rollback()` (closing the connection rolls
it back). `db.transaction(fn)` calls `fn` in a transaction, which is committed
when it returns, or rolled back if it throws:

```js
const insert = db.prepare('INSERT INTO foo (x) VALUES (?)');
db.transaction(() => {
  for (const x of [1, 2, 3]) {
    insert.run([x]);
  }
});
```

Until a query's rows have all been fetched (or the statement is closed, or the
iterator is left with `break` or `return`), its transaction is still going. An
iterator that's left part way through (such as one that only had `next()`
called once) keeps the file locked, so the other connections to it wait and
fail with `40001` after 5 seconds, and `db.begin()` (or `db.transaction(fn)`)
on the same connection fails with `25001`. Fetch all the rows, or close the
statement, first (see
[#5](https://github.com/elliotchance/vsql-node/issues/5)):

```js
const it = db.iterate('SELECT x FROM foo');
it.next();
db.begin(); // VsqlError 25001: active SQL-transaction
it.return(); // closes the statement
db.begin();
```

A transaction in another one (`db.transaction(fn)` while there's already a
transaction) is a savepoint, which is released when `fn` returns, or rolled back
to if it throws, so only what `fn` did is undone and the outer transaction
carries on (like better-sqlite3):

```js
db.transaction(() => {
  insert.run([1]);
  try {
    db.transaction(() => {
      insert.run([2]);
      throw new Error('undo 2');
    });
  } catch {}
  insert.run([3]);
}); // commits 1 and 3
```

`fn` can't call `db.commit()` or `db.rollback()` (they throw a `TypeError`, like
in better-sqlite3), since `db.transaction(fn)` ends the transaction (or the
savepoint) itself.

Ending a transaction closes the rows of its queries, which finishes their
iterators. A transaction can't be started while the rows of a query are being
iterated outside of one (they're still in the query's own transaction), so
`db.begin()` and `db.transaction(fn)` throw a `TypeError` until the iterator is
finished or left. Use `db.all()` to read the rows first. `START TRANSACTION`,
`COMMIT` and `ROLLBACK` can't be executed as statements.

In a transaction, `db.savepoint(name)` makes a savepoint, `db.rollback(name)`
rolls back what came after it (and the transaction carries on), and
`db.release(name)` releases it (and the savepoints after it), keeping what came
after it. The name is an identifier, like in SQL, so `'a'` is `A` and `'"a"'` is
`a`. They throw a `TypeError` if there's no transaction:

```js
db.begin();
insert.run([1]);
db.savepoint('a');
insert.run([2]);
db.rollback('a');
db.release('a');
db.commit(); // commits 1
```

vsql rolls back the whole transaction for some errors, such as a `40001`
serialization failure (other errors only undo the statement). After that,
`db.inTransaction` is `false` and each statement is committed on its own again.
If `fn` of `db.transaction(fn)` catches the error, the statements after it throw
a `TypeError` (rather than being committed one at a time), and so does
`db.transaction(fn)` when `fn` returns.

`db.begin(options)` and `db.transaction(fn, options)` take `readOnly` (`false`
by default) and `isolationLevel` (`"READ COMMITTED"` by default, or
`"READ UNCOMMITTED"`, `"REPEATABLE READ"` or `"SERIALIZABLE"`). The names are
case sensitive, so `'serializable'` is a `RangeError`:

```js
db.transaction(() => report(), { readOnly: true, isolationLevel: 'SERIALIZABLE' });
```

vsql runs `READ UNCOMMITTED` (which must be `readOnly`) as `READ COMMITTED`, and
`REPEATABLE READ` as `SERIALIZABLE`. A statement outside of a transaction is
`SERIALIZABLE` (vsql's default), unless the connection has another
`isolationLevel` (`vsql.connect(file, { isolationLevel: 'READ COMMITTED' })`). A
`SERIALIZABLE` transaction waits (up to 5 seconds, or the connection's
`lockTimeout`) for the other connections to the file, while a `READ COMMITTED`
one doesn't wait, and fails with `40001` if another transaction changed the same
rows. Since a wait blocks the event loop (see [API](#api)), the default for
`db.begin()` is `READ COMMITTED` instead of vsql's `SERIALIZABLE`.

## Parameters

Parameters are `?`, given as an array. Each JavaScript type is sent as an SQL
type, which is cast to the type it's used as:

| JavaScript               | SQL                                                    |
|--------------------------|--------------------------------------------------------|
| `null`, `undefined`      | `NULL`                                                 |
| `boolean`                | `BOOLEAN`                                              |
| `number`                 | `BIGINT` if it's a safe integer, otherwise `DOUBLE PRECISION` (`NaN` and `±Infinity` are a `RangeError`) |
| `bigint`                 | `BIGINT` (`NUMERIC` if it's out of range)              |
| `string`                 | `CHARACTER VARYING`                                    |
| `Buffer`, `Uint8Array`   | `BINARY VARYING` (also any other view, or an `ArrayBuffer`) |
| `Date`                   | `TIMESTAMP(3) WITH TIME ZONE` (in UTC)                 |
| `vsql.numeric(value)`    | `NUMERIC`                                              |
| `vsql.date(value)`       | `DATE`                                                 |
| `vsql.time(value)`       | `TIME` (`WITH TIME ZONE` if it has an offset)          |
| `vsql.timestamp(value)`  | `TIMESTAMP` (`WITH TIME ZONE` if it has an offset)     |

The type of a parameter comes from where it's used, and the value is cast to
it. So a `number` that isn't an integer is truncated when it's used as an
integer (`WHERE x = ?` with `1.5` is `x = 1` when `x` is an `INTEGER`), and a
`?` that has no type from where it's used (such as `SELECT ?`) is a syntax
error (`42601`). Use `CAST(? AS DOUBLE PRECISION)` to give it a type.

A string is cast to the type of the parameter (from where it's used), so it can
be a parameter for any type that isn't binary, in vsql's format (such as
`"2024-01-02"` for a `DATE`, `"1.5E+400"` for a `DECFLOAT` or `"-1-02"` for an
`INTERVAL YEAR TO MONTH`). A binary string can only be a `Buffer` (or another
view), and a `Buffer` can only be a binary string.

A string with a lone surrogate (such as `"\uD800"`) is a `RangeError`, because
it can't be converted to UTF-8 (see `String.prototype.isWellFormed`).

`vsql.numeric` (from a string such as `"-12.50"`, a number or a bigint),
`vsql.date` (`"YYYY-MM-DD"`), `vsql.time` (`"HH:MM:SS"`) and `vsql.timestamp`
(`"YYYY-MM-DD HH:MM:SS"`) send a value as that type instead, and take the
strings that the columns of those types are, so a value can be read and written
back:

```js
db.run('INSERT INTO events (at, price) VALUES (?, ?)', [
  vsql.timestamp('2024-01-02 15:04:05.123456+05:30'),
  vsql.numeric('9.99'),
]);
```

Times and timestamps have up to 6 fractional digits, and an optional offset
(`+05:30`, `+0530` or `Z`).

The value of a `DECFLOAT` or interval column is a string, so it can be written
back as it is.

## Columns

| SQL                                 | JavaScript                             |
|-------------------------------------|----------------------------------------|
| `SMALLINT`, `INTEGER`               | `number`                               |
| `BIGINT`                            | `number` (`bigint` with `{ bigint: true }`) |
| `REAL`, `DOUBLE PRECISION`          | `number`                               |
| `DECIMAL`, `NUMERIC`                | `string`, such as `"12.50"`            |
| `DECFLOAT`                          | `string`, such as `"1.5E+400"`         |
| `CHARACTER`, `VARCHAR`, `CLOB`      | `string`                               |
| `BINARY`, `VARBINARY`, `BLOB`       | `Buffer`                               |
| `BOOLEAN`                           | `boolean`                              |
| `DATE`                              | `string`, such as `"2024-01-02"`       |
| `TIME`                              | `string`, such as `"15:04:05.123456"`  |
| `TIME WITH TIME ZONE`               | `string`, such as `"15:04:05+05:30"`   |
| `TIMESTAMP`                         | `string`, such as `"2024-01-02T15:04:05.123456"` |
| `TIMESTAMP WITH TIME ZONE`          | `string`, such as `"2024-01-02T15:04:05.123456+05:30"` |
| `INTERVAL YEAR TO MONTH`, ...       | `string`, such as `"-1-02"` or `"3 04:05:06.500000"` |

A `NULL` is `null`. Decimals, dates, times and intervals are strings, so that no
precision is lost. An interval is the string of its literal (`"-1-02"` is
`INTERVAL '-1-02' YEAR TO MONTH`), and its qualifier is the `type` of the
column. A timestamp is in ISO 8601, so one `WITH TIME ZONE` can be given to
`new Date()`.

A `BIGINT` is a `number`, and a `RangeError` if it's out of the range that a
number can hold exactly (±2<sup>53</sup> - 1). With
`vsql.connect(..., { bigint: true })`, it's always a `bigint`.

## Errors

An error from vsql is a `vsql.VsqlError`, with its SQLSTATE as `sqlstate` (and
`code`):

```js
try {
  db.all('SELECT * FROM nope');
} catch (e) {
  if (e instanceof vsql.VsqlError) {
    console.log(e.sqlstate); // 42P01
  }
}
```

When vsql gives them, it also has the constraint that was violated
(`constraintCatalog`, `constraintSchema` and `constraintName`), the table
(`catalogName`, `schemaName` and `tableName`), the column (`columnName`) and the
cursor (`cursorName`). `more` is `true` if vsql raised more conditions than it
kept.

```js
try {
  db.run('INSERT INTO foo (id) VALUES (1)');
} catch (e) {
  console.log(e.sqlstate, e.constraintName, e.tableName); // 23505 FOO_PRIMARY_KEY FOO
}
```

`diagnostics` are the other conditions that vsql raised with the error, each an
object of `sqlstate`, `message` and the same fields (it's usually empty):

```js
try {
  db.all('SELECT SUM(x) / 0 FROM t');
} catch (e) {
  console.log(e.sqlstate, e.diagnostics); // 22012 [{ sqlstate: '01003', message: 'null value eliminated in set function' }]
}
```

An error from the driver itself (such as using a closed connection, or a value
that can't be a parameter) is a `TypeError` or `RangeError`.

### Warnings

A statement that succeeds with a warning from vsql (such as `01003` when a
`NULL` is eliminated from `SUM`, or `01004` when a string is truncated) gives a
`vsql.VsqlWarning` to `process.emitWarning`, which is how Node reports problems
that shouldn't stop the program. It has the same fields as a `VsqlError`. Node
prints warnings to stderr, unless they're handled with `process.on('warning')`
or Node is run with `--no-warnings` (or `--disable-warning=VsqlWarning`):

```js
process.on('warning', (w) => {
  if (w instanceof vsql.VsqlWarning) {
    console.log(w.sqlstate, w.message); // 01003 null value eliminated in set function (SQLSTATE 01003)
  }
});
```

## Threads

Each connection has its own libvsql environment, so connections in different
worker threads can be used at the same time. Connections to the same file
share a lock.

On Linux, libvsql's garbage collector uses `SIGPWR` and `SIGXCPU` to stop
threads, so don't listen for them with `process.on`.

## Requirements

Node 22 or later. The addon is prebuilt for macOS, Linux (with glibc 2.31 or
later, or musl, such as Alpine) and Windows, each for ARM64 and x86-64, so npm
doesn't need to compile anything. It uses Node-API, so the same prebuild works
for every version of Node.

Otherwise, it's compiled when it's installed, which needs Python and a C
compiler (see [node-gyp](https://github.com/nodejs/node-gyp#installation)), and
takes about 30 seconds. On Windows, it needs the "C++ Clang tools for Windows"
component of Visual Studio, since the C that V generates doesn't compile with
MSVC.

## Development

```sh
npm install   # compiles the addon into build/Release
npm test
```

The tests must cover every line and branch of `lib`, and every line of
`src/binding.c`. `npm run coverage` (on Linux or macOS) compiles the addon with
gcov, runs the tests and fails if anything wasn't run, listing what wasn't.
It's checked on each pull request. The addon it compiles includes
`test/fault.h`, so that `test/faults.test.js` can make each of the addon's
calls (to `malloc`, Node-API and libvsql) fail in turn, which reaches the code
that handles those failures. Run `npm run build` afterwards to compile the
addon normally again.

### Updating vsql

`internal/amalgamation` is the libvsql C from a vsql release
(`vsql-VERSION-amalgamation.zip`). To update it to the latest release:

```sh
scripts/update-amalgamation.sh
npm run build && npm test
```

Or give a version (`scripts/update-amalgamation.sh v1.2.3`), or a zip that has
already been downloaded. It needs an amalgamation from vsql v1.7.58 or later,
which has all of libvsql's C in one `libvsql.c`.

### Releasing

Publishing a GitHub release (with a tag such as `v1.2.3`) publishes the
package to npm ([release.yml](.github/workflows/release.yml)), with the
prebuilds from [test.yml](.github/workflows/test.yml).
