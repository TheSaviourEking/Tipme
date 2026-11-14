import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAX_SHARDS, shardCount, shardFiles } from './ci-burn-in.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const specs = (n) =>
  Array.from({ length: n }, (_, i) => `tests/e2e/s${i}.spec.ts`);

test('the fewest shards: none for no spec, one up to 8, one more per 8, at most the e2e six', () => {
  assert.equal(MAX_SHARDS, 6);
  const expected = {
    0: 0,
    1: 1,
    8: 1,
    9: 2,
    16: 2,
    17: 3,
    40: 5,
    41: 6,
    48: 6,
    49: 6,
    200: 6,
  };
  for (const [n, count] of Object.entries(expected))
    assert.equal(shardCount(Number(n)), count, `${n} specs`);
});

test('every changed spec runs in exactly one shard, and shares differ by at most one file', () => {
  for (const n of [1, 7, 8, 9, 41, 100]) {
    const files = specs(n);
    const count = shardCount(n);
    const shares = Array.from({ length: count }, (_, i) =>
      shardFiles(files, i + 1, count),
    );
    assert.deepEqual(shares.flat().sort(), [...files].sort(), `${n} specs`);
    const sizes = shares.map((share) => share.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `${n}: ${sizes}`);
    assert.ok(
      sizes.every((size) => size > 0),
      `${n}: an empty shard`,
    );
  }
});

test('the CLI plans the matrix and lists one shard’s files, one per line', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'burn-in-')), 'output');
  const SPECS = `${specs(9).join(' ')} `;
  const env = { ...process.env, SPECS, GITHUB_OUTPUT: out };
  execFileSync('node', [join(root, 'scripts/ci-burn-in.mjs'), 'plan'], { env });
  assert.equal(readFileSync(out, 'utf8'), 'count=2\nshards=[1,2]\n');

  const listed = execFileSync(
    'node',
    [join(root, 'scripts/ci-burn-in.mjs'), 'files', '2', '2'],
    {
      env,
      encoding: 'utf8',
    },
  );
  assert.deepEqual(listed.trim().split('\n'), shardFiles(specs(9), 2, 2));

  execFileSync('node', [join(root, 'scripts/ci-burn-in.mjs'), 'plan'], {
    env: { ...env, SPECS: ' ' },
  });
  assert.match(readFileSync(out, 'utf8'), /count=0\nshards=\[\]\n$/);
});

test('CI shards the burn-in and keeps one e2e-burn-in result that fails when any shard did', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  const job = (name) =>
    new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [a-z0-9-]+:\\n|$)`).exec(
      ci,
    )?.[1] ?? '';

  const plan = job('e2e-burn-in-plan');
  assert.match(plan, /node scripts\/ci-burn-in\.mjs plan/);

  const shard = job('e2e-burn-in-shard');
  assert.match(shard, /needs: \[changes, e2e-burn-in-plan\]/);
  assert.match(shard, /needs\.e2e-burn-in-plan\.outputs\.count != '0'/);
  assert.match(
    shard,
    /shard: \$\{\{ fromJSON\(needs\.e2e-burn-in-plan\.outputs\.shards\) \}\}/,
  );
  assert.match(shard, /fail-fast: false/);
  assert.match(shard, /--repeat-each=5 --retries=0/);
  assert.doesNotMatch(
    shard,
    /--shard/,
    'Playwright --shard would drop the @alone stage',
  );
  assert.match(
    shard,
    /name: e2e-burn-in-png-diagnostics-\$\{\{ matrix\.shard \}\}/,
  );
  const minutes = Number(/timeout-minutes: (\d+)/.exec(shard)?.[1]);
  assert.ok(minutes > 0 && minutes <= 40, `shard timeout ${minutes}`);

  const result = job('e2e-burn-in');
  assert.match(
    result,
    /needs: \[changes, e2e-burn-in-plan, e2e-burn-in-shard\]/,
  );
  assert.match(result, /!cancelled\(\)/);
  assert.match(result, /PLAN: \$\{\{ needs\.e2e-burn-in-plan\.result \}\}/);
  assert.match(result, /SHARDS: \$\{\{ needs\.e2e-burn-in-shard\.result \}\}/);

  assert.match(job('record-tested-tree'), /needs:[\s\S]*\be2e-burn-in\b/);
});
