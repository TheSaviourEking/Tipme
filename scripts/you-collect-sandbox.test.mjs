import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The You collect sandbox check (plan Task 16) is run by a person, never by CI: these only prove it
// refuses to start without the opt-in, a sandbox key and a step, before it loads anything or sends a
// request, and that it never prints the key.
const script = fileURLToPath(
  new URL('./you-collect-sandbox.mjs', import.meta.url),
);
const run = (args, env = {}) =>
  spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, ...env },
    timeout: 10_000,
  });

test('it refuses to run without --sandbox', () => {
  const result = run(['--step=start'], {
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_not_a_real_key',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /opt-in only: pass --sandbox/);
});

test('it refuses a live key, or none, and never prints the key', () => {
  for (const key of ['sk_live_not_a_real_key', '', 'sandbox_not_prefixed']) {
    const result = run(['--sandbox', '--step=start'], {
      BACHS_SANDBOX_API_KEY: key,
    });
    assert.equal(result.status, 2, key);
    assert.match(result.stderr, /must be set to an sk_sandbox_ key/);
    if (key) assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
  }
});

test('it refuses an unknown step', () => {
  const result = run(['--sandbox', '--step=payout'], {
    BACHS_SANDBOX_API_KEY: 'sk_sandbox_not_a_real_key',
  });
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /pass --step=start, --step=transfer or --step=evidence/,
  );
});

test('it only talks to the sandbox origin, through one guarded fetch', () => {
  const source = readFileSync(script, 'utf8');
  assert.match(
    source,
    /const SANDBOX_ORIGIN = 'https:\/\/sandbox-api\.bachs\.io';/,
  );
  // Every request, the adapter's and the script's own, goes through sandboxOnly.
  assert.match(source, /fetchImpl: sandboxOnly/);
  assert.equal((source.match(/\bfetch\(/g) ?? []).length, 1);
  assert.match(source, /return fetch\(input, init\);/);
  // No other partner origin is named anywhere, the live one included.
  assert.ok(
    !source.replace(/sandbox-api\.bachs\.io/g, '').includes('bachs.io'),
  );
});
