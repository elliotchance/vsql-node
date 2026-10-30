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

See [example/main.js](example/main.js) for a complete program:

```sh
node example/main.js
```

## API

The API is synchronous: each call runs vsql on the calling thread, and returns
when it's finished (like `node:sqlite` and better-sqlite3). To run queries at
the same time, use a connection in each
[worker thread](https://nodejs.org/api/worker_threads.html).

| Connection                      | Statement                 |                                                     |
|---------------------------------|---------------------------|-----------------------------------------------------|
| `db.prepare(sql)`               |                           | Prepares a statement                                |
| `db.run(sql, params)`           | `stmt.run(params)`        | Executes a statement, returns `{ changes }`         |
| `db.get(sql, params)`           | `stmt.get(params)`        | The first row of a query, or `undefined`            |
| `db.all(sql, params)`           | `stmt.all(params)`        | All the rows of a query                             |
| `db.iterate(sql, params)`       | `stmt.iterate(params)`    | An iterator of the rows, fetched one at a time      |
|                                 | `stmt.columns()`          | The name, type, nullability, length, precision and scale of each column |
|                                 | `stmt.raw()`              | Each row is an array instead of an object           |
| `db.close()`                    | `stmt.close()`            | Frees the connection or statement                   |

Each row is an object keyed by the column names, which vsql uppercases unless
they're quoted (`SELECT x` is `{ X: ... }`). Use `stmt.raw()` when columns have
the same name.

A statement that hasn't been closed is freed when it's garbage collected, as is
a connection (which rolls back its transaction). Both can be declared with
`using` (on Node 24 or later).

## Transactions

Each statement is committed when it finishes, or when all the rows of a query
have been fetched (or the iterator is left). `db.begin()` starts a transaction,
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

Ending a transaction closes the rows of its queries, which finishes their
iterators. `START TRANSACTION`, `COMMIT` and `ROLLBACK` can't be executed as
statements.

vsql's transactions are `READ COMMITTED`.

## Parameters

Parameters are `?`, given as an array. Each JavaScript type is sent as an SQL
type, which is cast to the type it's used as:

| JavaScript               | SQL                                                    |
|--------------------------|--------------------------------------------------------|
| `null`, `undefined`      | `NULL`                                                 |
| `boolean`                | `BOOLEAN`                                              |
| `number`                 | `BIGINT` if it's a safe integer, otherwise `DOUBLE PRECISION` |
| `bigint`                 | `BIGINT` (`NUMERIC` if it's out of range)              |
| `string`                 | `CHARACTER VARYING`                                    |
| `Date`                   | `TIMESTAMP(3) WITH TIME ZONE` (in UTC)                 |
| `vsql.numeric(value)`    | `NUMERIC`                                              |
| `vsql.date(value)`       | `DATE`                                                 |
| `vsql.time(value)`       | `TIME` (`WITH TIME ZONE` if it has an offset)          |
| `vsql.timestamp(value)`  | `TIMESTAMP` (`WITH TIME ZONE` if it has an offset)     |

vsql doesn't cast a `CHARACTER VARYING` to a number, date or time, so a string
can't be a parameter for those types. Instead, use `vsql.numeric` (from a
string such as `"-12.50"`, a number or a bigint), `vsql.date`
(`"YYYY-MM-DD"`), `vsql.time` (`"HH:MM:SS"`) or `vsql.timestamp`
(`"YYYY-MM-DD HH:MM:SS"`), which take the strings that the columns of those
types are, so a value can be read and written back:

```js
db.run('INSERT INTO events (at, price) VALUES (?, ?)', [
  vsql.timestamp('2024-01-02 15:04:05.123456+05:30'),
  vsql.numeric('9.99'),
]);
```

Times and timestamps have up to 6 fractional digits, and an optional offset
(`+05:30`, `+0530` or `Z`).

vsql doesn't have a binary type, so a `Buffer` can't be a parameter.

## Columns

| SQL                                 | JavaScript                             |
|-------------------------------------|----------------------------------------|
| `SMALLINT`, `INTEGER`               | `number`                               |
| `BIGINT`                            | `number` (`bigint` with `{ bigint: true }`) |
| `REAL`, `DOUBLE PRECISION`          | `number`                               |
| `DECIMAL`, `NUMERIC`                | `string`, such as `"12.50"`            |
| `CHARACTER`, `VARCHAR`              | `string`                               |
| `BOOLEAN`                           | `boolean`                              |
| `DATE`                              | `string`, such as `"2024-01-02"`       |
| `TIME`                              | `string`, such as `"15:04:05.123456"`  |
| `TIME WITH TIME ZONE`               | `string`, such as `"15:04:05+05:30"`   |
| `TIMESTAMP`                         | `string`, such as `"2024-01-02T15:04:05.123456"` |
| `TIMESTAMP WITH TIME ZONE`          | `string`, such as `"2024-01-02T15:04:05.123456+05:30"` |

A `NULL` is `null`. Decimals, dates and times are strings, so that no precision
is lost. A timestamp is in ISO 8601, so one `WITH TIME ZONE` can be given to
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

An error from the driver itself (such as using a closed connection, or a value
that can't be a parameter) is a `TypeError` or `RangeError`.

## Threads

Each connection has its own libvsql environment, so connections in different
worker threads can be used at the same time. Connections to the same file
share a lock.

On Linux, libvsql's garbage collector uses `SIGPWR` and `SIGXCPU` to stop
threads, so don't listen for them with `process.on`.

## Requirements

Node 22 or later. The addon is prebuilt for macOS (ARM64 and x86-64), Linux
(ARM64 and x86-64, with glibc 2.29 or later) and Windows (x86-64), so npm
doesn't need to compile anything. It uses Node-API, so the same prebuild works
for every version of Node.

Otherwise (such as with musl, on Alpine), it's compiled when it's installed,
which needs Python and a C compiler (see
[node-gyp](https://github.com/nodejs/node-gyp#installation)), and takes about
30 seconds. On Windows, it needs the "C++ Clang tools for Windows" component of
Visual Studio, since the C that V generates doesn't compile with MSVC.

## Development

```sh
npm install   # compiles the addon into build/Release
npm test
```

### Updating vsql

`internal/amalgamation` is the libvsql C from a vsql release
(`vsql-VERSION-amalgamation.zip`). To update it to the latest release:

```sh
scripts/update-amalgamation.sh
npm run build && npm test
```

Or give a version (`scripts/update-amalgamation.sh v1.2.3`), or a zip that has
already been downloaded.

### Releasing

Publishing a GitHub release (with a tag such as `v1.2.3`) publishes the
package to npm, with the prebuilds from
[release.yml](.github/workflows/release.yml).
