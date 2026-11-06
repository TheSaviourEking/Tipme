import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decidableCount } from '../src/lib/approvals-count.ts';

const row = (fields) => ({
  id: crypto.randomUUID(),
  mine: false,
  canDecide: false,
  ...fields,
});

test('only requests this person can decide are counted', () => {
  assert.equal(
    decidableCount([
      row({ canDecide: true }),
      row({ canDecide: true }),
      row({ canDecide: false }),
      row({ mine: true }),
    ]),
    2,
  );
});

test('their own request never counts, even if it were offered to them', () => {
  assert.equal(decidableCount([row({ mine: true, canDecide: true })]), 0);
});

test('an unknown list counts as unknown, not zero', () => {
  assert.equal(decidableCount(null), null);
  assert.equal(decidableCount([]), 0);
});
