import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// Every advisory the CI audit (`pnpm audit --prod --audit-level=high`) is told to skip lives in
// pnpm-workspace.yaml under auditConfig.ignoreGhsas, and needs an entry here: why it is safe for
// now, and the date it must be looked at again. From that date this test fails, so a skip can never
// outlive its reason quietly. Remove both lines once a patched version resolves (`pnpm why <pkg>`).
const EXCEPTIONS = {
  // picomatch ReDoS (single-branch repeated extglobs). No patched release yet (<= 4.0.7, the
  // latest). Only reached at build time: @sentry/nextjs > @rollup/plugin-commonjs > picomatch,
  // which never sees visitor input. Owner approved a skip until 1 Dec 2026 (17 Nov 2026).
  'GHSA-fc5q-39xc-vjpf': { until: '2026-12-01' },
};

function ignoredGhsas(yaml) {
  const block = yaml.match(
    /^auditConfig:\n\s+ignoreGhsas:\n((?:[ \t]+(?:-\s+.+|#.*)\n?)+)/m,
  );
  if (!block) return [];
  return [...block[1].matchAll(/^[ \t]+-\s+'?([A-Za-z0-9-]+)'?/gm)].map(
    (m) => m[1],
  );
}

test('every skipped audit advisory has a reason and an end date here, and nothing else is skipped', () => {
  const yaml = readFileSync('pnpm-workspace.yaml', 'utf8');
  assert.deepEqual(ignoredGhsas(yaml).sort(), Object.keys(EXCEPTIONS).sort());
});

test('no audit skip is past its end date', () => {
  const today = new Date().toISOString().slice(0, 10);
  for (const [id, { until }] of Object.entries(EXCEPTIONS)) {
    assert.ok(
      today < until,
      `${id} was skipped until ${until}. Check for a patched version, then remove the skip or ask the owner to extend it.`,
    );
  }
});

test('the reader finds skips written the way pnpm-workspace.yaml writes them', () => {
  const yaml =
    "packages:\n  - 'apps/*'\n\nauditConfig:\n  ignoreGhsas:\n    # why, until when\n    - GHSA-aaaa-bbbb-cccc\n    - 'GHSA-dddd-eeee-ffff'\n";
  assert.deepEqual(ignoredGhsas(yaml), [
    'GHSA-aaaa-bbbb-cccc',
    'GHSA-dddd-eeee-ffff',
  ]);
  assert.deepEqual(ignoredGhsas("packages:\n  - 'apps/*'\n"), []);
});
