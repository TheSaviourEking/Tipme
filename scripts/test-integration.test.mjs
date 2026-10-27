import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INTEGRATION_FILES, nodeTestArgs } from './test-integration.mjs';

test('integration files run in parallel, optionally one shard of them', () => {
  const args = nodeTestArgs({ concurrency: 4 });
  assert.deepEqual(args.slice(0, 4), [
    '--import',
    './packages/observability/dist/register.js',
    '--test',
    '--test-concurrency=4',
  ]);
  assert.deepEqual(args.slice(-INTEGRATION_FILES.length), INTEGRATION_FILES);
  assert.ok(!args.some((arg) => arg.startsWith('--test-shard')));
  assert.ok(
    nodeTestArgs({ concurrency: 2, shard: '2/3' }).includes('--test-shard=2/3'),
  );
});

test('a malformed shard or concurrency is refused rather than running everything', () => {
  for (const shard of ['3', '0/3', '4/3', 'a/b'])
    assert.throws(() => nodeTestArgs({ concurrency: 2, shard }), /shard/);
  for (const concurrency of [0, -1, 1.5, Number.NaN])
    assert.throws(() => nodeTestArgs({ concurrency }), /concurrency/);
});
