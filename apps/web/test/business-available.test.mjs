import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  businessAvailable,
  createBusinessReader,
} from '../src/lib/business/available.ts';

// PR B1: the web invites people to create a business only when the API says it is on.

test('only an explicit business: true is on', () => {
  assert.equal(businessAvailable({ business: true }), true);
  for (const release of [
    { business: false },
    { business: 'true' },
    {},
    null,
    undefined,
    'business',
  ])
    assert.equal(businessAvailable(release), false, JSON.stringify(release));
});

test('the answer is kept a minute; a failed read is off and retried soon', async () => {
  let clock = 0;
  let reads = 0;
  let fail = true;
  const read = createBusinessReader({
    read: async () => {
      reads += 1;
      if (fail) throw new Error('down');
      return { business: true };
    },
    now: () => clock,
  });
  assert.equal(await read(), false);
  clock = 4_000;
  assert.equal(await read(), false);
  assert.equal(reads, 1, 'the failure is kept for a few seconds');
  fail = false;
  clock = 6_000;
  assert.equal(await read(), true);
  clock = 60_000;
  assert.equal(await read(), true);
  assert.equal(reads, 2, 'a good answer is kept a minute');
  clock = 67_000;
  await Promise.all([read(), read()]);
  assert.equal(reads, 3, 'reads at the same moment share one request');
});
