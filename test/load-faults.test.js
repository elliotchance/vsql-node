'use strict';

// Loading the addon when its calls fail (see test/faults.test.js), in another
// process for each, since the addon is only loaded once by each process. This
// file doesn't load the addon itself.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { test } = require('node:test');

const skip = process.env.VSQL_NODE_COVERAGE ? false : 'needs scripts/coverage.sh';

test('loading the addon fails', { skip }, () => {
  const root = path.join(__dirname, '..');
  // The first call is calloc, and the second is napi_set_instance_data.
  for (const [n, message] of [[1, /out of memory/], [2, /./]]) {
    const result = spawnSync(process.execPath, ['-e', "require('./lib/binding')"], {
      cwd: root,
      env: { ...process.env, VSQL_NODE_FAULT: `load:${n}` },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, message);
  }
});
