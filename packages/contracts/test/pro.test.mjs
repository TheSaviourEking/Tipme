import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PRO_PRICE_MAX_MINOR,
  PRO_PRICE_MIN_MINOR,
  opsProPriceChangeSchema,
} from '../dist/index.js';

const parse = (amountMinor) =>
  opsProPriceChangeSchema.safeParse({
    amountMinor,
    reason: 'Launch price agreed with the owner today',
  });

test('a Pro price is whole naira between ₦100 and ₦1,000,000, sent as a kobo string', () => {
  assert.equal(PRO_PRICE_MIN_MINOR, 10_000n);
  assert.equal(PRO_PRICE_MAX_MINOR, 100_000_000n);
  assert.equal(parse('300000').success, true);
  assert.equal(parse('10000').success, true);
  assert.equal(parse('100000000').success, true);
  for (const bad of [
    '9999',
    '100000100',
    '250050',
    '-250000',
    '2500.00',
    250000,
    '',
  ])
    assert.equal(parse(bad).success, false, String(bad));
  assert.equal(
    opsProPriceChangeSchema.safeParse({
      amountMinor: '300000',
      reason: 'short',
    }).success,
    false,
  );
});
