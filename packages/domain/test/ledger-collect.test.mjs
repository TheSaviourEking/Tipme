import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildAbsorbedRefundPosting,
  buildCollectPaymentPosting,
  buildCollectRefundPosting,
  buildCollectReturnPosting,
  buildCollectTransferPosting,
  buildDisputeFeePosting,
  buildDisputeLossPosting,
  isBalanced,
  priceTip,
} from '../dist/index.js';

// Deterministic LCG so failures are reproducible (same as ledger.test.mjs).
let seed = 7n;
const next = (max) => {
  seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n);
  return seed % max;
};

const quoteAt = (tip, bps) => priceTip(tip, undefined, { shareBps: bps });
const paymentInput = (tip, bps, actual, extra = {}) => {
  const q = quoteAt(tip, bps);
  return {
    grossMinor: tip,
    platformFeeMinor: q.platformFeeMinor,
    quotedProviderFeeMinor: q.providerFeeMinor,
    actualProviderFeeMinor: actual(q.providerFeeMinor),
    recipientNetMinor: q.recipientNetMinor,
    profileId: 'p1',
    ...extra,
  };
};
const sum = (lines, account, side) =>
  lines
    .filter((l) => l.account === account && l.side === side)
    .reduce((t, l) => t + l.amountMinor, 0n);

test('a collect payment balances for Free, Pro, local card and bank transfer', () => {
  for (const bps of [500n, 300n]) {
    for (const tip of [200_000n, 1_000_000n, 10_000_000n]) {
      const actuals = [
        (q) => q,
        (q) => q + 5_000n,
        (q) => (q > 5_000n ? q - 5_000n : 0n),
        (q) => q + 50n, // the real +/-50 kobo variance
        (q) => (q > 50n ? q - 50n : 0n),
        () => 0n, // bank transfer
      ];
      for (const actual of actuals) {
        const input = paymentInput(tip, bps, actual);
        const lines = buildCollectPaymentPosting(input);
        assert.ok(isBalanced(lines), `unbalanced ${tip} @ ${bps}`);
        assert.ok(lines.every((l) => l.amountMinor > 0n));
        const held = lines.find(
          (l) => l.account === 'held_for_recipients' && l.profileId === 'p1',
        );
        assert.equal(held.side, 'debit');
        assert.equal(held.amountMinor, input.recipientNetMinor);
      }
    }
  }
});

test("an international card makes TipMe's line a credit", () => {
  // Pro 3% on ₦2,000: fee 6000, quoted processing 4000, actual 7000 (2% + 1.5%).
  const input = {
    grossMinor: 200_000n,
    platformFeeMinor: 2_000n,
    quotedProviderFeeMinor: 4_000n,
    actualProviderFeeMinor: 7_000n,
    recipientNetMinor: 194_000n,
    profileId: 'p1',
  };
  const lines = buildCollectPaymentPosting(input);
  const clearing = lines.filter((l) => l.account === 'platform_clearing');
  assert.deepEqual(clearing, [
    { account: 'platform_clearing', side: 'credit', amountMinor: 1_000n },
  ]);
  assert.ok(isBalanced(lines));
});

test("golden: the person's net is exactly the quote", () => {
  // ₦10,000 Free: fee 50000 (platform 35000 + processing 15000), net 950000.
  const lines = buildCollectPaymentPosting({
    grossMinor: 1_000_000n,
    platformFeeMinor: 35_000n,
    quotedProviderFeeMinor: 15_000n,
    actualProviderFeeMinor: 15_000n,
    recipientNetMinor: 950_000n,
    profileId: 'p1',
  });
  assert.deepEqual(lines, [
    {
      account: 'held_for_recipients',
      side: 'debit',
      amountMinor: 950_000n,
      profileId: 'p1',
    },
    {
      account: 'platform_clearing',
      side: 'debit',
      amountMinor: 35_000n,
    },
    {
      account: 'provider_fee_expense',
      side: 'debit',
      amountMinor: 15_000n,
    },
    {
      account: 'platform_fee_revenue',
      side: 'credit',
      amountMinor: 35_000n,
    },
    {
      account: 'provider_fee_recovered',
      side: 'credit',
      amountMinor: 15_000n,
    },
    {
      account: 'recipient_payable',
      side: 'credit',
      amountMinor: 950_000n,
      profileId: 'p1',
    },
  ]);
});

test('a share on a collect tip is held for the business', () => {
  const lines = buildCollectPaymentPosting(
    paymentInput(1_000_000n, 500n, (x) => x, {
      businessShare: { businessId: 'b1', amountMinor: 100_000n },
    }),
  );
  assert.ok(isBalanced(lines));
  const heldDebits = lines.filter(
    (l) => l.account === 'held_for_recipients' && l.side === 'debit',
  );
  assert.deepEqual(heldDebits, [
    {
      account: 'held_for_recipients',
      side: 'debit',
      amountMinor: 850_000n,
      profileId: 'p1',
    },
    {
      account: 'held_for_recipients',
      side: 'debit',
      amountMinor: 100_000n,
      businessId: 'b1',
    },
  ]);
  assert.deepEqual(
    lines.find((l) => l.account === 'business_payable'),
    {
      account: 'business_payable',
      side: 'credit',
      amountMinor: 100_000n,
      businessId: 'b1',
    },
  );
});

test('transfer and return postings mirror each other and leave the payable alone', () => {
  for (const owner of [{ profileId: 'p1' }, { businessId: 'b1' }]) {
    const out = buildCollectTransferPosting({ amountMinor: 5_000n, ...owner });
    const back = buildCollectReturnPosting({ amountMinor: 5_000n, ...owner });
    assert.ok(isBalanced(out) && isBalanced(back));
    assert.deepEqual(
      out.map((l) => [l.account, l.side]),
      [
        ['provider_clearing', 'debit'],
        ['held_for_recipients', 'credit'],
      ],
    );
    assert.deepEqual(
      back.map((l) => [l.account, l.side]),
      [
        ['held_for_recipients', 'debit'],
        ['provider_clearing', 'credit'],
      ],
    );
    for (const l of [...out, ...back]) {
      assert.notEqual(l.account, 'recipient_payable');
      assert.notEqual(l.account, 'business_payable');
    }
    const held = out[1];
    assert.equal(held.profileId, owner.profileId);
    assert.equal(held.businessId, owner.businessId);
  }
});

test("a refund of a held share takes the payable and the held money, never TipMe's fee", () => {
  const lines = buildCollectRefundPosting({
    parts: [
      { amountMinor: 850_000n, profileId: 'p1' },
      { amountMinor: 100_000n, businessId: 'b1' },
    ],
    refundFeeMinor: 300n,
  });
  assert.ok(isBalanced(lines));
  assert.deepEqual(lines, [
    {
      account: 'recipient_payable',
      side: 'debit',
      amountMinor: 850_000n,
      profileId: 'p1',
    },
    {
      account: 'held_for_recipients',
      side: 'credit',
      amountMinor: 850_000n,
      profileId: 'p1',
    },
    {
      account: 'business_payable',
      side: 'debit',
      amountMinor: 100_000n,
      businessId: 'b1',
    },
    {
      account: 'held_for_recipients',
      side: 'credit',
      amountMinor: 100_000n,
      businessId: 'b1',
    },
    { account: 'provider_fee_expense', side: 'debit', amountMinor: 300n },
    { account: 'platform_clearing', side: 'credit', amountMinor: 300n },
  ]);
  assert.ok(lines.every((l) => l.account !== 'platform_fee_revenue'));
});

test("an absorbed refund and a dispute fee are TipMe's own money", () => {
  const refund = buildAbsorbedRefundPosting({
    amountMinor: 950_000n,
    refundFeeMinor: 300n,
  });
  assert.ok(isBalanced(refund));
  assert.deepEqual(refund, [
    { account: 'refund_loss_expense', side: 'debit', amountMinor: 950_000n },
    { account: 'provider_fee_expense', side: 'debit', amountMinor: 300n },
    { account: 'platform_clearing', side: 'credit', amountMinor: 950_300n },
  ]);
  const fee = buildDisputeFeePosting({ feeMinor: 1_500_000n });
  assert.ok(isBalanced(fee));
  assert.deepEqual(fee, [
    { account: 'dispute_fee_expense', side: 'debit', amountMinor: 1_500_000n },
    { account: 'platform_clearing', side: 'credit', amountMinor: 1_500_000n },
  ]);
});

test('a lost dispute recovers what was held and TipMe absorbs the rest', () => {
  const gross = 1_000_000n;
  const net = 950_000n;
  const cases = [
    { recovered: [{ amountMinor: net, profileId: 'p1' }], loss: gross - net },
    {
      recovered: [{ amountMinor: 300_000n, profileId: 'p1' }],
      loss: gross - 300_000n,
    },
    { recovered: [], loss: gross },
  ];
  for (const { recovered, loss } of cases) {
    const lines = buildDisputeLossPosting({ disputedMinor: gross, recovered });
    assert.ok(isBalanced(lines));
    assert.equal(sum(lines, 'dispute_loss_expense', 'debit'), loss);
    assert.equal(sum(lines, 'platform_clearing', 'credit'), loss);
    assert.equal(
      sum(lines, 'held_for_recipients', 'credit'),
      recovered.reduce((t, r) => t + r.amountMinor, 0n),
    );
    assert.equal(
      sum(lines, 'recipient_payable', 'debit'),
      sum(lines, 'held_for_recipients', 'credit'),
    );
  }
});

test('every collect posting balances', () => {
  for (let i = 0; i < 1000; i++) {
    const tip = 200_000n + next(10_000_000n);
    const bps = next(2n) === 0n ? 500n : 300n;
    const q = quoteAt(tip, bps);
    const actual = next(q.providerFeeMinor * 3n + 1n);
    const input = {
      grossMinor: tip,
      platformFeeMinor: q.platformFeeMinor,
      quotedProviderFeeMinor: q.providerFeeMinor,
      actualProviderFeeMinor: actual,
      recipientNetMinor: q.recipientNetMinor,
      profileId: 'p1',
    };
    const net = q.recipientNetMinor;
    if (next(2n) === 0n) {
      input.businessShare = {
        businessId: 'b1',
        amountMinor: 1n + next(net / 2n),
      };
    }
    const pay = buildCollectPaymentPosting(input);
    assert.ok(isBalanced(pay), `payment ${tip}`);
    assert.ok(pay.every((l) => l.amountMinor > 0n));

    const amount = 1n + next(net);
    const owner = next(2n) === 0n ? { profileId: 'p1' } : { businessId: 'b1' };
    assert.ok(
      isBalanced(
        buildCollectTransferPosting({ amountMinor: amount, ...owner }),
      ),
    );
    assert.ok(
      isBalanced(buildCollectReturnPosting({ amountMinor: amount, ...owner })),
    );
    const fee = next(2n) === 0n ? undefined : next(5_000n);
    const parts = [
      { amountMinor: amount, profileId: 'p1' },
      { amountMinor: 1n + next(net), businessId: 'b1' },
    ];
    assert.ok(
      isBalanced(
        buildCollectRefundPosting({
          parts,
          ...(fee !== undefined ? { refundFeeMinor: fee } : {}),
        }),
      ),
    );
    assert.ok(
      isBalanced(
        buildAbsorbedRefundPosting({
          amountMinor: amount,
          ...(fee !== undefined ? { refundFeeMinor: fee } : {}),
        }),
      ),
    );
    assert.ok(
      isBalanced(buildDisputeFeePosting({ feeMinor: 1n + next(9_999n) })),
    );
    const total = parts.reduce((t, p) => t + p.amountMinor, 0n);
    const disputed = total + next(1_000_000n);
    const lost = buildDisputeLossPosting({
      disputedMinor: disputed,
      recovered: parts,
    });
    assert.ok(isBalanced(lost), 'dispute loss');
    assert.ok(lost.every((l) => l.amountMinor > 0n));
  }
});

test('refused: a team on a collect payment, a zero or negative amount, recovery above the disputed amount', () => {
  const base = paymentInput(1_000_000n, 500n, (x) => x);
  const { profileId: _p, ...noProfile } = base;
  assert.throws(
    () =>
      buildCollectPaymentPosting({
        ...noProfile,
        teamSplits: [{ profileId: 'p1', amountMinor: base.recipientNetMinor }],
      }),
    RangeError,
  );
  for (const bad of [0n, -1n]) {
    assert.throws(
      () => buildCollectTransferPosting({ amountMinor: bad, profileId: 'p1' }),
      RangeError,
    );
    assert.throws(
      () => buildCollectReturnPosting({ amountMinor: bad, businessId: 'b1' }),
      RangeError,
    );
    assert.throws(
      () =>
        buildCollectRefundPosting({
          parts: [{ amountMinor: bad, profileId: 'p1' }],
        }),
      RangeError,
    );
    assert.throws(
      () => buildAbsorbedRefundPosting({ amountMinor: bad }),
      RangeError,
    );
    assert.throws(() => buildDisputeFeePosting({ feeMinor: bad }), RangeError);
    assert.throws(
      () => buildDisputeLossPosting({ disputedMinor: bad, recovered: [] }),
      RangeError,
    );
  }
  assert.throws(() => buildCollectRefundPosting({ parts: [] }), RangeError);
  assert.throws(
    () =>
      buildCollectTransferPosting({
        amountMinor: 1n,
        profileId: 'p1',
        businessId: 'b1',
      }),
    RangeError,
  );
  assert.throws(
    () =>
      buildDisputeLossPosting({
        disputedMinor: 100n,
        recovered: [{ amountMinor: 101n, profileId: 'p1' }],
      }),
    RangeError,
  );
});

test('a lost dispute can recover a business-owned part', () => {
  const lines = buildDisputeLossPosting({
    disputedMinor: 1_000_000n,
    recovered: [
      { amountMinor: 850_000n, profileId: 'p1' },
      { amountMinor: 100_000n, businessId: 'b1' },
    ],
  });
  assert.ok(isBalanced(lines));
  assert.deepEqual(lines.slice(0, 4), [
    {
      account: 'recipient_payable',
      side: 'debit',
      amountMinor: 850_000n,
      profileId: 'p1',
    },
    {
      account: 'held_for_recipients',
      side: 'credit',
      amountMinor: 850_000n,
      profileId: 'p1',
    },
    {
      account: 'business_payable',
      side: 'debit',
      amountMinor: 100_000n,
      businessId: 'b1',
    },
    {
      account: 'held_for_recipients',
      side: 'credit',
      amountMinor: 100_000n,
      businessId: 'b1',
    },
  ]);
  assert.equal(sum(lines, 'dispute_loss_expense', 'debit'), 50_000n);
});

test('the held and payable lines land on the right owner', () => {
  for (let i = 0; i < 200; i++) {
    const tip = 200_000n + next(10_000_000n);
    const q = quoteAt(tip, 500n);
    const net = q.recipientNetMinor;
    const share = 1n + next(net / 2n);
    const lines = buildCollectPaymentPosting({
      grossMinor: tip,
      platformFeeMinor: q.platformFeeMinor,
      quotedProviderFeeMinor: q.providerFeeMinor,
      actualProviderFeeMinor: q.providerFeeMinor,
      recipientNetMinor: net,
      profileId: 'p1',
      businessShare: { businessId: 'b1', amountMinor: share },
    });
    const of = (account) =>
      lines
        .filter((l) => l.account === account)
        .map((l) => [l.profileId, l.businessId, l.amountMinor]);
    assert.deepEqual(of('held_for_recipients'), [
      ['p1', undefined, net - share],
      [undefined, 'b1', share],
    ]);
    assert.deepEqual(of('recipient_payable'), [['p1', undefined, net - share]]);
    assert.deepEqual(of('business_payable'), [[undefined, 'b1', share]]);
  }
});

test('refused: an owner with no id, negative fees', () => {
  const base = paymentInput(1_000_000n, 500n, (x) => x);
  for (const profileId of [undefined, '']) {
    assert.throws(
      () => buildCollectPaymentPosting({ ...base, profileId }),
      RangeError,
    );
  }
  for (const owner of [{}, { profileId: '' }, { businessId: '' }]) {
    assert.throws(
      () => buildCollectTransferPosting({ amountMinor: 1n, ...owner }),
      RangeError,
    );
    assert.throws(
      () => buildCollectReturnPosting({ amountMinor: 1n, ...owner }),
      RangeError,
    );
    assert.throws(
      () =>
        buildCollectRefundPosting({ parts: [{ amountMinor: 1n, ...owner }] }),
      RangeError,
    );
    assert.throws(
      () =>
        buildDisputeLossPosting({
          disputedMinor: 5n,
          recovered: [{ amountMinor: 1n, ...owner }],
        }),
      RangeError,
    );
  }
  // Fees that offset each other must still be refused one by one.
  assert.throws(
    () =>
      buildCollectPaymentPosting({
        ...base,
        platformFeeMinor: base.platformFeeMinor + 100n,
        recipientNetMinor: base.recipientNetMinor - 200n,
        quotedProviderFeeMinor: base.quotedProviderFeeMinor + 100n,
        actualProviderFeeMinor: -1n,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      buildCollectPaymentPosting({
        ...base,
        platformFeeMinor: -100n,
        recipientNetMinor:
          base.recipientNetMinor + base.platformFeeMinor + 100n,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      buildCollectPaymentPosting({
        ...base,
        quotedProviderFeeMinor: -100n,
        recipientNetMinor:
          base.recipientNetMinor + base.quotedProviderFeeMinor + 100n,
      }),
    RangeError,
  );
  assert.throws(
    () =>
      buildCollectRefundPosting({
        parts: [{ amountMinor: 1n, profileId: 'p1' }],
        refundFeeMinor: -1n,
      }),
    RangeError,
  );
  assert.throws(
    () => buildAbsorbedRefundPosting({ amountMinor: 1n, refundFeeMinor: -1n }),
    RangeError,
  );
});
