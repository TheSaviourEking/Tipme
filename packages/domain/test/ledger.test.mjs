import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildPaymentPosting,
  buildPayoutPosting,
  buildReversalPosting,
  isBalanced,
  priceTip,
  splitShare,
} from '../dist/index.js';

// Deterministic LCG so failures are reproducible.
let seed = 42n;
const next = (max) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
  return seed % max;
};

test('payment postings always balance and never contain zero or negative lines', () => {
  for (let i = 0; i < 500; i++) {
    const tip = 100_000n + next(10_000_000n - 100_000n + 1n);
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

test("a business's payout takes its own business_payable, never a person's (R2-B)", () => {
  const lines = buildPayoutPosting({ amountMinor: 93500n, businessId: 'b1' });
  assert.ok(isBalanced(lines));
  assert.deepEqual(lines, [
    {
      account: 'business_payable',
      side: 'debit',
      amountMinor: 93500n,
      businessId: 'b1',
    },
    { account: 'provider_clearing', side: 'credit', amountMinor: 93500n },
  ]);
  // A person's payout is byte-identical to before.
  assert.deepEqual(
    buildPayoutPosting({ amountMinor: 93500n, profileId: 'p1' }),
    [
      {
        account: 'recipient_payable',
        side: 'debit',
        amountMinor: 93500n,
        profileId: 'p1',
      },
      { account: 'provider_clearing', side: 'credit', amountMinor: 93500n },
    ],
  );
  // Exactly one owner.
  assert.throws(() => buildPayoutPosting({ amountMinor: 1n }), RangeError);
  assert.throws(
    () =>
      buildPayoutPosting({
        amountMinor: 1n,
        profileId: 'p1',
        businessId: 'b1',
      }),
    RangeError,
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

// ---- Business release 2 (plan R2-A Task 28) ----

/** Debits minus credits per account and owner: what a set of lines does to each balance. */
const effect = (lines) => {
  const out = new Map();
  for (const l of lines) {
    const key = `${l.account}|${l.profileId ?? ''}|${l.businessId ?? ''}`;
    const signed = l.side === 'debit' ? l.amountMinor : -l.amountMinor;
    out.set(key, (out.get(key) ?? 0n) + signed);
  }
  return out;
};

// A ₦2,000 tip: ₦200 platform fee, ₦30 quoted provider fee, ₦1,770 net; the provider took ₦31.
const TODAY = {
  grossMinor: 200000n,
  platformFeeMinor: 20000n,
  quotedProviderFeeMinor: 3000n,
  actualProviderFeeMinor: 3100n,
  recipientNetMinor: 177000n,
  profileId: 'p1',
};

test('golden: a posting without a share or a team is byte-identical to before', () => {
  assert.deepEqual(buildPaymentPosting(TODAY), [
    { account: 'provider_clearing', side: 'debit', amountMinor: 196900n },
    { account: 'provider_fee_expense', side: 'debit', amountMinor: 3100n },
    { account: 'platform_fee_revenue', side: 'credit', amountMinor: 20000n },
    { account: 'provider_fee_recovered', side: 'credit', amountMinor: 3000n },
    {
      account: 'recipient_payable',
      side: 'credit',
      amountMinor: 177000n,
      profileId: 'p1',
    },
  ]);
  // A fee-free tip (no platform fee) still drops its zero line, as before.
  assert.deepEqual(
    buildPaymentPosting({
      ...TODAY,
      platformFeeMinor: 0n,
      recipientNetMinor: 197000n,
      actualProviderFeeMinor: 0n,
    }).map((l) => l.account),
    ['provider_clearing', 'provider_fee_recovered', 'recipient_payable'],
  );
});

test("a share posting balances, and the share is the business's own line", () => {
  const { personMinor, businessMinor } = splitShare(177001n, 1000);
  const lines = buildPaymentPosting({
    ...TODAY,
    platformFeeMinor: 19999n,
    recipientNetMinor: 177001n,
    businessShare: { businessId: 'b1', amountMinor: businessMinor },
  });
  assert.ok(isBalanced(lines));
  const person = lines.filter((l) => l.account === 'recipient_payable');
  const business = lines.filter((l) => l.account === 'business_payable');
  assert.deepEqual(person, [
    {
      account: 'recipient_payable',
      side: 'credit',
      amountMinor: personMinor,
      profileId: 'p1',
    },
  ]);
  assert.deepEqual(business, [
    {
      account: 'business_payable',
      side: 'credit',
      amountMinor: 17700n,
      businessId: 'b1',
    },
  ]);
  assert.equal(personMinor, 159301n);
  // TipMe's fee and the provider lines are exactly today's (Q9: the share comes from the net).
  assert.deepEqual(
    lines.filter((l) => !l.account.endsWith('_payable')),
    buildPaymentPosting({
      ...TODAY,
      platformFeeMinor: 19999n,
      recipientNetMinor: 177001n,
    }).filter((l) => l.account !== 'recipient_payable'),
  );
});

test('a share above half the net, zero, or with a team is refused', () => {
  const share = (amountMinor) => ({
    ...TODAY,
    businessShare: { businessId: 'b1', amountMinor },
  });
  assert.throws(() => buildPaymentPosting(share(88501n)), RangeError);
  assert.throws(() => buildPaymentPosting(share(0n)), RangeError);
  assert.doesNotThrow(() => buildPaymentPosting(share(88500n)));
  assert.throws(
    () =>
      buildPaymentPosting({
        ...share(100n),
        profileId: undefined,
        teamSplits: [{ profileId: 'p1', amountMinor: 177000n }],
      }),
    RangeError,
  );
});

test('team splits balance, one line each, and must add up to the net', () => {
  const { profileId: _drop, ...rest } = TODAY;
  const lines = buildPaymentPosting({
    ...rest,
    teamSplits: [
      { profileId: 'p1', amountMinor: 59000n },
      { profileId: 'p2', amountMinor: 59000n },
      { profileId: 'p3', amountMinor: 59000n },
    ],
  });
  assert.ok(isBalanced(lines));
  assert.deepEqual(
    lines
      .filter((l) => l.account === 'recipient_payable')
      .map((l) => [l.profileId, l.amountMinor]),
    [
      ['p1', 59000n],
      ['p2', 59000n],
      ['p3', 59000n],
    ],
  );
  assert.throws(
    () =>
      buildPaymentPosting({
        ...rest,
        teamSplits: [{ profileId: 'p1', amountMinor: 176999n }],
      }),
    RangeError,
  );
  assert.throws(
    () =>
      buildPaymentPosting({
        ...TODAY,
        teamSplits: [{ profileId: 'p1', amountMinor: 177000n }],
      }),
    RangeError,
  );
  assert.throws(() => buildPaymentPosting({ ...rest }), RangeError);
});

const SHARED = buildPaymentPosting({
  ...TODAY,
  businessShare: { businessId: 'b1', amountMinor: 17700n },
});

test('a full reversal mirrors every line exactly, sides swapped', () => {
  const reversal = buildReversalPosting(SHARED);
  assert.ok(isBalanced(reversal));
  assert.deepEqual(
    reversal,
    SHARED.map((l) => ({
      ...l,
      side: l.side === 'debit' ? 'credit' : 'debit',
    })),
  );
  const net = effect([...SHARED, ...reversal]);
  for (const value of net.values()) assert.equal(value, 0n);
});

test('a partial reversal balances, takes the refund exactly, and never exceeds any line', () => {
  for (let i = 0; i < 500; i++) {
    const tip = 200_000n + next(10_000_000n - 200_000n + 1n);
    const quote = priceTip(tip);
    const bps = [1000, 2000, 3000, 5000][Number(next(4n))];
    const { businessMinor } = splitShare(quote.recipientNetMinor, bps);
    const original = buildPaymentPosting({
      grossMinor: tip,
      platformFeeMinor: quote.platformFeeMinor,
      quotedProviderFeeMinor: quote.providerFeeMinor,
      actualProviderFeeMinor: quote.providerFeeMinor + next(3n),
      recipientNetMinor: quote.recipientNetMinor,
      profileId: 'p1',
      businessShare: { businessId: 'b1', amountMinor: businessMinor },
    });
    const refunded = 1n + next(tip - 1n);
    const reversal = buildReversalPosting(original, {
      num: refunded,
      den: tip,
    });
    assert.ok(isBalanced(reversal), `unbalanced for ${refunded}/${tip}`);
    const debits = reversal
      .filter((l) => l.side === 'debit')
      .reduce((sum, l) => sum + l.amountMinor, 0n);
    assert.equal(debits, refunded);
    for (const l of reversal) {
      assert.ok(l.amountMinor > 0n);
      const from = original.find(
        (o) =>
          o.account === l.account &&
          o.profileId === l.profileId &&
          o.businessId === l.businessId,
      );
      assert.ok(from, `no original line for ${l.account}`);
      assert.notEqual(from.side, l.side);
      assert.ok(
        l.amountMinor <= from.amountMinor,
        `${l.account} exceeds its line`,
      );
    }
  }
});

test("a partial reversal puts the remainder kobo on the person's line", () => {
  // Half of 1,000 kobo across lines that each round down: 3 + 3 + 3 = 9 of 10 per side.
  const original = [
    { account: 'provider_clearing', side: 'debit', amountMinor: 1000n },
    { account: 'platform_fee_revenue', side: 'credit', amountMinor: 333n },
    {
      account: 'recipient_payable',
      side: 'credit',
      amountMinor: 334n,
      profileId: 'p1',
    },
    {
      account: 'business_payable',
      side: 'credit',
      amountMinor: 333n,
      businessId: 'b1',
    },
  ];
  const reversal = buildReversalPosting(original, { num: 1n, den: 2n });
  assert.deepEqual(reversal, [
    { account: 'provider_clearing', side: 'credit', amountMinor: 500n },
    { account: 'platform_fee_revenue', side: 'debit', amountMinor: 166n },
    {
      account: 'recipient_payable',
      side: 'debit',
      amountMinor: 168n,
      profileId: 'p1',
    },
    {
      account: 'business_payable',
      side: 'debit',
      amountMinor: 166n,
      businessId: 'b1',
    },
  ]);
});

test('a reversal of nothing, more than the payment, or of an unbalanced posting is refused', () => {
  assert.throws(
    () => buildReversalPosting(SHARED, { num: 0n, den: 10n }),
    RangeError,
  );
  assert.throws(
    () => buildReversalPosting(SHARED, { num: 11n, den: 10n }),
    RangeError,
  );
  assert.throws(
    () => buildReversalPosting(SHARED, { num: 1n, den: 0n }),
    RangeError,
  );
  assert.throws(() => buildReversalPosting(SHARED.slice(1)), RangeError);
  // So small a refund that it rounds to nothing.
  assert.throws(
    () => buildReversalPosting(SHARED, { num: 1n, den: 10n ** 12n }),
    RangeError,
  );
});
