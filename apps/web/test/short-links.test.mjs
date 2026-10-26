import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import test from 'node:test';
import { isReservedHandle, normaliseHandle } from '@tipme/domain';

// `/handle` leads to `/@handle`, so any single-word page or public folder that could also be a
// handle must be reserved, or someone could claim the address of a TipMe page.
const names = (dir) =>
  readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);

test('every top-level route and public folder that could be a handle is reserved', () => {
  const candidates = [...names('../src/app/'), ...names('../public/')]
    .filter((name) => !name.startsWith('[') && !name.startsWith('('))
    .filter((name) => normaliseHandle(name) !== null);
  assert.ok(candidates.length > 0);
  for (const name of candidates)
    assert.equal(isReservedHandle(name), true, `${name} must be reserved`);
});
