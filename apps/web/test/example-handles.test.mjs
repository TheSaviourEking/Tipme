import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { isReservedHandle } from '@tipme/domain';

// Every address the marketing components print as an example must be one nobody can claim
// (review I3). The handles are read from the source, so a new example fails here until reserved.
const sources = [
  '../src/components/marketing.tsx',
  '../src/app/pro/page.tsx',
  '../src/components/marketing/where-you-meet-people.tsx',
  '../src/components/demo-cards.tsx',
];

test('every example handle in the marketing components is reserved', () => {
  const found = new Set();
  for (const file of sources) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8');
    for (const match of text.matchAll(/usetipme\.xyz\/@([a-z0-9_]{3,30})\b/g))
      found.add(match[1]);
    for (const match of text.matchAll(/\bhandle="([a-z0-9_]{3,30})"/g))
      found.add(match[1]);
    for (const list of text.matchAll(/HANDLES = \[([^\]]+)\]/g))
      for (const match of list[1].matchAll(/'([a-z0-9_]{3,30})'/g))
        found.add(match[1]);
  }
  for (const handle of ['ada', 'tobi', 'zainab'])
    assert.ok(found.has(handle), `${handle} should be found in the examples`);
  for (const handle of found)
    assert.equal(isReservedHandle(handle), true, `${handle} must be reserved`);
});
