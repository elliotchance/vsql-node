'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const vsql = require('..');

// The garbage collector's fork handlers crashed every process that was spawned
// after the addon was loaded (on Linux), even while it isn't being used.
test('processes can be spawned after the addon is loaded', () => {
  const db = vsql.connect(':memory:');
  try {
    assert.deepEqual(db.all('VALUES 1'), [{ COL1: 1 }]);
    const result = spawnSync(process.execPath, ['-e', "require('.'); console.log('ok')"], {
      cwd: `${__dirname}/..`,
      encoding: 'utf8',
    });
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'ok\n');
  } finally {
    db.close();
  }
});
