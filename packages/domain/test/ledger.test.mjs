import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPaymentPosting,
  buildPayoutPosting,
  isBalanced,
  priceTip,
} from '../dist/index.js';

// Deterministic LCG so failures are reproducible.
let seed = 42n;
const next = (max) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
  return seed % max;
};

test('payment postings always balance and never contain zero or negative lines', () => {
  for (let i = 0; i < 500; i++) {
    const tip = 100n + next(10_000_000n - 100n + 1n);
    const quote = priceTip(tip);
    const delta = next(101n) - 50n;
    const actual =
      quote.providerFeeMinor + delta < 0n ? 0n : quote.providerFeeMinor + delta;
    const lines = buildPaymentPosting({
      grossMinor: tip,
      platformFeeMinor: quote.platformFeeMinor,
      quotedProviderFeeMinor: quote.providerFeeMinor,
      actualProviderFeeMinor: actual,
      recipientNetMinor: quote.recipientNetMinor,
      profileId: 'p1',
    });
    assert.ok(isBalanced(lines), `unbalanced for tip ${tip}`);
    assert.ok(lines.every((line) => line.amountMinor > 0n));
    const payable = lines.find((line) => line.account === 'recipient_payable');
    assert.equal(payable.amountMinor, quote.recipientNetMinor);
    assert.equal(payable.side, 'credit');
  }
});

test('payout postings balance and move the payable to provider clearing', () => {
  const lines = buildPayoutPosting({ amountMinor: 93500n, profileId: 'p1' });
  assert.ok(isBalanced(lines));
  assert.deepEqual(
    lines.map((line) => [line.account, line.side]),
    [
      ['recipient_payable', 'debit'],
      ['provider_clearing', 'credit'],
    ],
  );
});

test('an inconsistent breakdown is refused', () => {
  assert.throws(() =>
    buildPaymentPosting({
      grossMinor: 100000n,
      platformFeeMinor: 5000n,
      quotedProviderFeeMinor: 1500n,
      actualProviderFeeMinor: 1500n,
      recipientNetMinor: 90000n,
      profileId: 'p1',
    }),
  );
  assert.throws(() =>
    buildPaymentPosting({
      grossMinor: 100n,
      platformFeeMinor: 5n,
      quotedProviderFeeMinor: 2n,
      actualProviderFeeMinor: 101n,
      recipientNetMinor: 93n,
      profileId: 'p1',
    }),
  );
});
