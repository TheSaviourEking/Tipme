import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHARDS = 3;

/** Playwright's own --list, one "[project] › file › title" per test. */
function listed(args, env = {}) {
  const output = execFileSync(
    join(root, 'node_modules/.bin/playwright'),
    ['test', '--list', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } },
  );
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('['));
}

test('CI shards split the suite: each test once, and none far from a fair share', () => {
  const whole = listed([]);
  const shards = Array.from({ length: SHARDS }, (_, index) =>
    listed([`--shard=${index + 1}/${SHARDS}`]),
  );
  const together = shards.flat();
  assert.equal(new Set(together).size, together.length, 'a test ran twice');
  assert.deepEqual([...together].sort(), [...whole].sort());
  for (const shard of shards)
    assert.ok(
      // Serial files stay together, so a share is near even, not exact.
      Math.abs(shard.length - whole.length / SHARDS) <=
        (whole.length / SHARDS) * 0.15,
      `${shard.length} of ${whole.length}`,
    );
});

test('@alone tests are never in a sharded run, and have a run of their own', () => {
  const alone = listed([], { E2E_ALONE: '1' });
  assert.ok(alone.length > 0);
  for (const line of alone) assert.match(line, /^\[desktop-alone\].*@alone/);
  for (const line of listed([])) assert.doesNotMatch(line, /@alone/);
});

test('CI gives @alone its own job in the matrix, not behind a shard', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const job = (name) =>
    new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z-]+:\\n)`).exec(
      ci,
    )?.[1] ?? '';
  assert.match(job('e2e'), /shard: \[1, 2, 3, alone\]/);
  // scripts/test-integration.mjs only takes numbered shards.
  assert.match(job('integration'), /shard: \[1, 2, 3\]/);
  assert.match(ci, /fail-fast: false/);
  assert.match(ci, /test:e2e --alone/);
});

test('test:e2e runs both stages through the stage script', () => {
  const script = readFileSync(join(root, 'scripts/run-e2e.mjs'), 'utf8');
  assert.match(script, /E2E_ALONE/);
});
