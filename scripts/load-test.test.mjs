import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withOneRetry } from './load-test.mjs';

const runs = (...codes) => {
  const seen = [];
  return {
    seen,
    run: async () => {
      seen.push('run');
      return codes.shift();
    },
  };
};

test('missed budgets get one more run, so a slow CI machine alone cannot fail the check', async () => {
  const flaky = runs(99, 0);
  const log = [];
  assert.equal(await withOneRetry(flaky.run, (line) => log.push(line)), 0);
  assert.equal(flaky.seen.length, 2);
  assert.match(log.join('\n'), /once more/);

  // A real slowdown misses the budgets twice and still fails.
  const slow = runs(99, 99);
  assert.equal(await withOneRetry(slow.run, () => {}), 99);
  assert.equal(slow.seen.length, 2);
});

test('a pass, or any failure other than missed budgets, is final', async () => {
  for (const code of [0, 1, 107]) {
    const once = runs(code, 0);
    assert.equal(await withOneRetry(once.run, () => {}), code);
    assert.equal(once.seen.length, 1);
  }
});
