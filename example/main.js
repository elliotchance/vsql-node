// A complete program that uses vsql:
//
//   node example/main.js

'use strict';

const vsql = require('..');

const db = vsql.connect(':memory:');

db.run(`CREATE TABLE products (
  id INTEGER NOT NULL,
  name VARCHAR(50) NOT NULL,
  price NUMERIC(10, 2),
  added DATE)`);

const insert = db.prepare('INSERT INTO products (id, name, price, added) VALUES (?, ?, ?, ?)');
db.transaction(() => {
  insert.run([1, 'Bolt', vsql.numeric('0.25'), vsql.date('2024-01-02')]);
  insert.run([2, 'Nut', vsql.numeric('0.10'), vsql.date('2024-03-04')]);
  insert.run([3, 'Washer', null, null]);
});
insert.close();

const select = db.prepare('SELECT name, price, added FROM products WHERE id > ? ORDER BY id');
console.log(select.columns().map((c) => c.name));
for (const row of select.iterate([1])) {
  console.log(row.NAME, row.PRICE, row.ADDED);
}
select.close();

try {
  db.all('SELECT * FROM nope');
} catch (e) {
  if (!(e instanceof vsql.VsqlError)) {
    throw e;
  }
  console.log(`${e.sqlstate}: ${e.message}`);
}

db.close();
