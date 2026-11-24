import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withdrawalPartCount } from '@tipme/domain';
import {
  TOO_SMALL,
  belowMinimum,
  partsView,
  requestParts,
  collectDelayLine,
  collectWithdrawView,
  withdrawableNow,
  withdrawDayNote,
  withdrawFee,
  withdrawSummary,
  withdrawLamp,
  withdrawRefusal,
  withdrawState,
  withdrawUnsure,
} from '../src/lib/withdraw-state.ts';

const ready = (over = {}) => ({
  state: 'ready',
  withdrawableMinor: '180000',
  ledgerMinor: '180000',
  providerMinor: '500000',
  feeMinor: '5000',
  feePaidBy: 'user',
  destination: { bankName: 'GTBank', last4: '1234' },
  inReview: false,
  ...over,
});
const of = (quote, available = true) =>
  withdrawState({ withdrawalsAvailable: available, quote });

test('ready says where the money goes and that the fee comes off the amount', () => {
  const view = of(ready());
  assert.equal(view.canWithdraw, true);
  assert.equal(
    view.notice.body,
    'You can withdraw ₦1,800 to GTBank ••1234. Transfer fee: ₦50, charged by our payment partner. It comes off the amount you withdraw.',
  );
});

test('kobo are shown only when there are some', () => {
  assert.match(
    of(ready({ withdrawableMinor: '180050' })).notice.body,
    /₦1,800\.50 to/,
  );
});

test('ready with nothing withdrawable disables Withdraw and says why', () => {
  const empty = of(
    ready({ withdrawableMinor: '0', ledgerMinor: '0', providerMinor: '0' }),
  );
  assert.equal(empty.canWithdraw, false);
  assert.equal(empty.notice.body, 'You have nothing to withdraw yet.');
  const notArrived = of(ready({ withdrawableMinor: '0', providerMinor: '0' }));
  assert.equal(notArrived.canWithdraw, false);
  assert.match(notArrived.notice.body, /still on the way/);
  assert.doesNotMatch(notArrived.notice.body, /nothing to withdraw/);
});

test('every other state has its own words and no Withdraw', () => {
  const cases = [
    [
      { state: 'paused', reason: 'reversal' },
      'Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz',
    ],
    [
      { state: 'provider_unavailable' },
      'We can’t check your balance with our payment partner right now. Try again in a few minutes.',
    ],
    [
      { state: 'no_destination' },
      'Add the bank account you want to be paid to.',
    ],
    [
      { state: 'setup_needed', requirementsDue: [] },
      'Finish setting up how you get paid to withdraw.',
    ],
    [
      { state: 'destination_pending' },
      'Your bank account is being checked. You can withdraw once it’s confirmed.',
    ],
  ];
  for (const [quote, body] of cases) {
    const view = of({ ...quote, inReview: false });
    assert.equal(view.canWithdraw, false, quote.state);
    assert.equal(view.notice.body, body);
  }
  assert.ok(of({ state: 'no_destination', inReview: false }).notice.href);
  assert.ok(
    of({ state: 'setup_needed', requirementsDue: [], inReview: false }).notice
      .href,
  );
});

test('a payout in review is said in any state, without stopping another', () => {
  const review = 'Our payment partner is checking it.';
  assert.equal(of(ready({ inReview: true })).review, review);
  assert.equal(of(ready({ inReview: true })).canWithdraw, true);
  assert.equal(
    of({ state: 'paused', reason: 'in_debt', inReview: true }).review,
    review,
  );
  assert.equal(of(ready()).review, null);
});

const HELD_ELSEWHERE =
  'Some of your tips were paid in a way TipMe can’t pay out from yet. Your tips are safe, and your balance stays here until withdrawals open.';

test('tips collected elsewhere are never read as a balance we cannot check', () => {
  const view = of({ state: 'provider_unavailable', inReview: false }, false);
  assert.equal(view.kind, 'held_elsewhere');
  assert.equal(view.canWithdraw, false);
  assert.equal(view.notice.body, HELD_ELSEWHERE);
  assert.doesNotMatch(view.notice.body, /can’t check your balance/);
  assert.equal(of(null, false).kind, 'held_elsewhere');
});

// Per-provider balances, Task 9 (spec §6): money held where withdrawals can't reach it no longer
// blocks the rest. A ready quote decides; its flags add notices beside a usable form.
test('a ready quote is usable even when some money is held elsewhere', () => {
  const view = of(ready({ heldElsewhere: true }), false);
  assert.equal(view.kind, 'ready');
  assert.equal(view.canWithdraw, true);
  assert.equal(view.showForm, true);
  assert.deepEqual(
    view.extraNotices.map((notice) => notice.body),
    [HELD_ELSEWHERE],
  );
  assert.doesNotMatch(JSON.stringify(view.extraNotices), /mock|bachs/i);
});

test('each flag on a ready quote adds its own notice, and none adds nothing', () => {
  assert.deepEqual(of(ready()).extraNotices, []);
  assert.deepEqual(
    of(
      ready({ partial: false, bankDetailsNeeded: false, heldElsewhere: false }),
    ).extraNotices,
    [],
  );
  const [partial, ...noMore] = of(ready({ partial: true })).extraNotices;
  assert.equal(noMore.length, 0);
  assert.equal(
    partial.body,
    'Some of your balance can’t be withdrawn right now. Try again later.',
  );
  assert.equal(partial.href, undefined);
  const [bank] = of(ready({ bankDetailsNeeded: true })).extraNotices;
  assert.equal(
    bank.body,
    'Add your bank details again to withdraw all of your balance.',
  );
  assert.equal(bank.href, '/dashboard/settings#get-paid');
  assert.ok(bank.linkLabel);
  const [held] = of(ready({ heldElsewhere: true })).extraNotices;
  assert.equal(held.body, HELD_ELSEWHERE);
  for (const notice of [partial, bank, held]) assert.ok(notice.title);
  // All three at once, in this order: what can't be read, what the person can fix, what is elsewhere.
  assert.deepEqual(
    of(
      ready({ partial: true, bankDetailsNeeded: true, heldElsewhere: true }),
    ).extraNotices.map((notice) => notice.body),
    [partial.body, bank.body, held.body],
  );
  // A state that isn't ready has none: its own notice says it.
  assert.deepEqual(
    of({ state: 'no_destination', inReview: false }).extraNotices,
    [],
  );
  assert.deepEqual(of(null).extraNotices, []);
});

test('partsFor counts the payments an amount takes, as the request would split it', () => {
  const caps = ['372000', '228000'];
  const view = of(ready({ withdrawableMinor: '600000', capsMinor: caps }));
  for (const amount of [100000n, 200000n, 372000n, 400000n, 600000n])
    assert.equal(
      view.partsFor(amount),
      withdrawalPartCount(amount, caps.map(BigInt)) ?? 1,
      String(amount),
    );
  assert.equal(view.partsFor(300000n), 1);
  assert.equal(view.partsFor(600000n), 2);
  // Not capsMinor.length: one provider covering the amount is one payment.
  assert.equal(view.partsFor(372000n), 1);
  // Nothing to split by: one payment.
  assert.equal(of(ready()).partsFor(100000n), 1);
  assert.equal(of(null).partsFor(100000n), 1);
  assert.equal(view.partsFor(0n), 1);
});

test('a split request’s parts say each one’s state, and "Partly sent" while some are sent and others not', () => {
  assert.equal(partsView(null), null);
  assert.equal(partsView([{ amountMinor: '100000', state: 'sent' }]), null);
  const going = partsView([
    { amountMinor: '372000', state: 'requested' },
    { amountMinor: '228000', state: 'processing' },
  ]);
  assert.equal(going.label, null);
  assert.deepEqual(
    going.parts.map((part) => part.words),
    ['on its way', 'on its way'],
  );
  const partly = partsView([
    { amountMinor: '372000', state: 'sent' },
    { amountMinor: '228000', state: 'in_review' },
  ]);
  assert.equal(partly.label, 'Partly sent');
  assert.deepEqual(
    partly.parts.map((part) => [part.amountMinor, part.words, part.tone]),
    [
      ['372000', 'sent', 'green'],
      ['228000', 'on its way', 'amber'],
    ],
  );
  const sentAndFailed = partsView([
    { amountMinor: '372000', state: 'sent' },
    { amountMinor: '228000', state: 'failed' },
  ]);
  assert.equal(sentAndFailed.label, 'Partly sent');
  assert.equal(sentAndFailed.parts[1].words, 'failed');
  const allSent = partsView([
    { amountMinor: '372000', state: 'sent' },
    { amountMinor: '228000', state: 'sent' },
  ]);
  assert.equal(allSent.label, null);
  const allFailed = partsView([
    { amountMinor: '372000', state: 'failed' },
    { amountMinor: '228000', state: 'failed' },
  ]);
  assert.equal(allFailed.label, null);
});

test('a quote that could not be fetched never allows a withdrawal', () => {
  const view = of(null);
  assert.equal(view.kind, 'provider_unavailable');
  assert.equal(view.canWithdraw, false);
});

test('no state names a provider', () => {
  for (const quote of [ready(), { state: 'paused', reason: 'reversal' }])
    assert.doesNotMatch(
      JSON.stringify(of({ inReview: true, ...quote })),
      /bachs|mock/i,
    );
});

test('withdrawals switched off for everyone say so plainly, with no form and no provider named', () => {
  const view = of({ state: 'paused', reason: 'switched_off' });
  assert.equal(view.canWithdraw, false);
  assert.equal(view.showForm, false);
  assert.equal(
    view.notice.body,
    'Withdrawals are paused for now. Your balance is safe.',
  );
  assert.doesNotMatch(JSON.stringify(view.notice), /bachs/i);
});

// The amount shown can be up to a few seconds old (the partner's figures are cached for the
// quote), while the withdrawal itself is checked fresh. A refusal over the amount must reload it.
test('a refused amount keeps its message and reloads the figures', () => {
  assert.deepEqual(withdrawRefusal('INSUFFICIENT_BALANCE'), {
    message: 'That is more than your available balance.',
    reload: true,
  });
  assert.deepEqual(withdrawRefusal('WITHDRAWAL_TOO_SMALL'), {
    message: 'The smallest withdrawal is ₦2,000.',
    reload: true,
  });
});

test('a refusal the page itself explains reloads with no message', () => {
  for (const code of [
    'WITHDRAWALS_PAUSED',
    'WITHDRAWALS_SWITCHED_OFF',
    'PAYOUT_SETUP_NEEDED',
    'PAYOUT_DESTINATION_NEEDED',
    'PAYOUT_PROVIDER_UNAVAILABLE',
  ])
    assert.deepEqual(withdrawRefusal(code), { message: null, reload: true });
});

test('an answer that may follow a recorded request only says so', () => {
  assert.deepEqual(withdrawRefusal('IDEMPOTENCY_CONFLICT'), {
    message:
      'This withdrawal may already be on its way. Check your dashboard before asking again.',
    reload: false,
  });
  for (const code of ['NETWORK', undefined])
    assert.deepEqual(withdrawRefusal(code), {
      message:
        'We couldn’t confirm your withdrawal. Check your dashboard before trying again.',
      reload: false,
    });
});

const now = (quote, available = '1000000', withdrawalsAvailable = true) =>
  withdrawableNow({ availableMinor: available, withdrawalsAvailable, quote });

test('withdrawableNow is what the quote allows, never more than the balance', () => {
  assert.equal(now(ready({ withdrawableMinor: '180000' })), BigInt(180000));
  assert.equal(
    now(ready({ withdrawableMinor: '900000' }), '500000'),
    BigInt(500000),
  );
});

test('withdrawableNow is zero for a balance the quote refuses', () => {
  assert.equal(now(ready({ withdrawableMinor: '0' })), BigInt(0));
  for (const state of [
    'paused',
    'setup_needed',
    'no_destination',
    'destination_pending',
    'provider_unavailable',
  ])
    assert.equal(now({ state, inReview: false }), BigInt(0), state);
  assert.equal(now(null), BigInt(0));
  // Money held elsewhere no longer blocks a ready quote (spec §6): only a quote that isn't ready.
  assert.equal(now(ready(), '1000000', false), BigInt(180000));
  assert.equal(now(null, '1000000', false), BigInt(0));
});

test('after a live change TipMe could not size, the page asks the person to check, and withdraws nothing', () => {
  const state = withdrawState({
    withdrawalsAvailable: true,
    quote: null,
    needsCheck: true,
  });
  assert.equal(state.kind, 'needs_check');
  assert.equal(state.canWithdraw, false);
  assert.equal(state.showForm, true);
  assert.equal(state.notice.title, 'Check what you can withdraw');
  assert.equal(
    withdrawableNow({
      availableMinor: '900000',
      withdrawalsAvailable: true,
      quote: null,
      needsCheck: true,
    }),
    0n,
  );
  // Money collected elsewhere still comes first.
  assert.equal(
    withdrawState({
      withdrawalsAvailable: false,
      quote: null,
      needsCheck: true,
    }).kind,
    'held_elsewhere',
  );
});

/** One view per row of the plan's mapping (W1 Task 2). */
const allStates = () => [
  of(ready()),
  of(ready({ withdrawableMinor: '0', ledgerMinor: '0', providerMinor: '0' })),
  of({ state: 'provider_unavailable', inReview: false }),
  of(null),
  of({ state: 'no_destination', inReview: false }),
  of({ state: 'setup_needed', requirementsDue: [], inReview: false }),
  of({ state: 'destination_pending', inReview: false }),
  of({ state: 'paused', reason: 'switched_off', inReview: false }),
  of({ state: 'paused', reason: 'held', inReview: false }),
  of({ state: 'provider_unavailable', inReview: false }, false),
];

test('the lamp line follows the state, and ready says what can go now', () => {
  const r = of(ready({ withdrawableMinor: '540000' }));
  assert.deepEqual(withdrawLamp(r, 540000n), {
    tone: 'purple',
    text: 'Ready to withdraw ₦5,400',
  });
  // The most that can go now, not the quote: withdrawableNow() is passed in.
  assert.equal(withdrawLamp(r, 300000n).text, 'Ready to withdraw ₦3,000');
  assert.equal(r.place, 'instrument');
  assert.deepEqual(withdrawLamp(r, 0n), {
    tone: 'off',
    text: 'Nothing to withdraw right now',
  });
});

test('no bank is a stamped slip; a pause is a standing warning; the rest stay on the instrument', () => {
  const bank = of({ state: 'no_destination', inReview: false });
  assert.equal(bank.place, 'slip');
  assert.equal(bank.stamp, 'Needs\na bank');
  assert.deepEqual(withdrawLamp(bank, 0n), {
    tone: 'off',
    text: 'Add a bank to withdraw',
  });
  for (const reason of ['switched_off', 'held']) {
    const paused = of({ state: 'paused', reason, inReview: false });
    assert.equal(paused.place, 'warning');
    assert.equal(paused.stamp, undefined);
    assert.deepEqual(withdrawLamp(paused, 0n), {
      tone: 'amber',
      text: 'Paused for now',
    });
  }
  for (const quote of [
    { state: 'provider_unavailable' },
    { state: 'setup_needed', requirementsDue: [] },
    { state: 'destination_pending' },
  ])
    assert.equal(of({ inReview: false, ...quote }).place, 'instrument');
  assert.deepEqual(
    withdrawLamp(of({ state: 'provider_unavailable', inReview: false }), 0n),
    { tone: 'amber', text: 'We can’t check your balance' },
  );
  assert.deepEqual(withdrawLamp(of(null), 0n), {
    tone: 'amber',
    text: 'We can’t check your balance',
  });
  assert.deepEqual(
    withdrawLamp(
      of({ state: 'setup_needed', requirementsDue: [], inReview: false }),
      0n,
    ),
    { tone: 'off', text: 'Finish your setup' },
  );
  assert.deepEqual(
    withdrawLamp(of({ state: 'destination_pending', inReview: false }), 0n),
    { tone: 'amber', text: 'Your bank account is being checked' },
  );
  const elsewhere = of(
    { state: 'provider_unavailable', inReview: false },
    false,
  );
  assert.equal(elsewhere.place, 'instrument');
  assert.deepEqual(withdrawLamp(elsewhere, 0n), {
    tone: 'off',
    text: 'Withdrawals aren’t available yet',
  });
});

test('a lamp line never carries a money reassurance', () => {
  for (const view of allStates())
    for (const withdrawable of [0n, 540000n])
      assert.doesNotMatch(
        withdrawLamp(view, withdrawable).text,
        /safe|protected|guarantee/i,
      );
});

test('the review line names our payment partner, never the provider', () => {
  const view = of(ready({ withdrawableMinor: '180000', inReview: true }));
  assert.equal(view.review, 'Our payment partner is checking it.');
});

test('only the answers that may have followed a request are unsure, and they say nothing about money', () => {
  assert.deepEqual(withdrawUnsure('IDEMPOTENCY_CONFLICT'), {
    title: 'This withdrawal may already be on its way',
    body: 'Check your dashboard before asking again.',
  });
  for (const code of [
    undefined,
    'INTERNAL_ERROR',
    'NETWORK',
    'DEPENDENCY_UNAVAILABLE',
  ])
    assert.deepEqual(withdrawUnsure(code), {
      title: 'We couldn’t confirm your withdrawal',
      body: 'Check your dashboard before trying again.',
    });
  for (const code of [
    'INSUFFICIENT_BALANCE',
    'WITHDRAWAL_TOO_SMALL',
    'WITHDRAWALS_PAUSED',
    'WITHDRAWALS_SWITCHED_OFF',
    'PAYOUT_SETUP_NEEDED',
    'PAYOUT_DESTINATION_NEEDED',
    'PAYOUT_PROVIDER_UNAVAILABLE',
  ])
    assert.equal(withdrawUnsure(code), null);
  for (const code of ['IDEMPOTENCY_CONFLICT', 'INTERNAL_ERROR']) {
    const { title, body } = withdrawUnsure(code);
    assert.doesNotMatch(`${title} ${body}`, /money|balance|paid|safe/i);
  }
});

test('the unsure words are today’s sentence, split at the full stop', () => {
  for (const code of ['IDEMPOTENCY_CONFLICT', 'INTERNAL_ERROR']) {
    const { title, body } = withdrawUnsure(code);
    assert.equal(`${title}. ${body}`, withdrawRefusal(code).message);
  }
});

test('the fee line says who pays the transfer fee, and nothing when there is none', () => {
  // Owner, 12 Nov 2026: users pay it, from the amount.
  assert.equal(
    withdrawFee(ready()),
    'Transfer fee: ₦50, charged by our payment partner. It comes off the amount you withdraw.',
  );
  // Owner, 18 Nov 2026: a person's withdrawals are free (TipMe pays). The API sends no fee for them.
  assert.equal(
    withdrawFee(ready({ feePaidBy: 'tipme', feeMinor: '0' })),
    'Withdrawals are free: you receive the whole amount.',
  );
  assert.equal(
    withdrawFee(ready({ feePaidBy: 'tipme' })),
    'Withdrawals are free: you receive the whole amount.',
  );
  assert.equal(withdrawFee(ready({ feeMinor: '0' })), null);
  assert.equal(withdrawFee({ state: 'no_destination', inReview: false }), null);
  assert.equal(withdrawFee(null), null);
});

test('below the minimum is only an amount under ₦2,000 that is not everything that can go', () => {
  assert.equal(belowMinimum(150000n, 540000n), true);
  assert.equal(belowMinimum(150000n, 150000n), false); // the whole of it, under the minimum: allowed
  assert.equal(belowMinimum(200000n, 540000n), false);
  assert.equal(belowMinimum(null, 540000n), false);
  assert.equal(belowMinimum(0n, 540000n), false);
  assert.equal(
    TOO_SMALL,
    'Too small. The smallest withdrawal is ₦2,000, or your whole balance if it’s less.',
  );
});

test('the summary: withdraw ₦10,000, the ₦50 fee, you receive ₦9,950 (owner, 12 Nov 2026)', () => {
  const quote = ready({ withdrawableMinor: '1000000' });
  assert.deepEqual(withdrawSummary(quote, 1_000_000n), {
    feeMinor: 5000n,
    feePaidBy: 'user',
    receiveMinor: 995_000n,
  });
  // Everything: the whole balance, less the fee.
  assert.deepEqual(withdrawSummary(ready(), 180_000n), {
    feeMinor: 5000n,
    feePaidBy: 'user',
    receiveMinor: 175_000n,
  });
  // TipMe pays (owner, 18 Nov 2026): a ₦0 fee for the user, and what arrives is the amount.
  assert.deepEqual(withdrawSummary(ready({ feePaidBy: 'tipme' }), 180_000n), {
    feeMinor: 0n,
    feePaidBy: 'tipme',
    receiveMinor: 180_000n,
  });
  assert.deepEqual(
    withdrawSummary(ready({ feePaidBy: 'tipme', feeMinor: '0' }), 1_000_000n),
    { feeMinor: 0n, feePaidBy: 'tipme', receiveMinor: 1_000_000n },
  );
  // Nothing would arrive.
  assert.equal(withdrawSummary(ready(), 5000n), null);
  assert.equal(withdrawSummary(null, 5000n), null);
});

test('a balance of ₦50 or less says plainly why it can’t be withdrawn', () => {
  const view = of(ready({ withdrawableMinor: '4000', ledgerMinor: '4000' }));
  assert.equal(view.canWithdraw, false);
  assert.equal(
    view.notice.body,
    'Your ₦40 isn’t more than the ₦50 transfer fee, so it can’t be withdrawn yet. It stays in your balance.',
  );
  assert.equal(of(ready({ withdrawableMinor: '5000' })).canWithdraw, false);
  assert.equal(of(ready({ withdrawableMinor: '5001' })).canWithdraw, true);
  // When TipMe pays, there is no such floor.
  assert.equal(
    of(ready({ withdrawableMinor: '4000', feePaidBy: 'tipme' })).canWithdraw,
    true,
  );
  assert.match(
    withdrawRefusal('WITHDRAWAL_BELOW_FEE').message,
    /more than the ₦50 transfer fee/,
  );
});

test('the fee line names its source plainly, never the partner, and a different fee is explained', async () => {
  const { FEE_DIFFERENCE_NOTE } = await import('../src/lib/withdraw-state.ts');
  assert.equal(
    withdrawFee(ready({ feeMinor: '10000' })),
    'Transfer fee: ₦100, charged by our payment partner. It comes off the amount you withdraw.',
  );
  assert.match(FEE_DIFFERENCE_NOTE, /charges a different fee/);
  assert.match(FEE_DIFFERENCE_NOTE, /your balance/);
  for (const text of [withdrawFee(ready()), FEE_DIFFERENCE_NOTE])
    assert.doesNotMatch(text, /bachs|paystack|flutterwave/i);
});

test('a person’s ready notice says withdrawals are free, with no fee figure (owner, 18 Nov 2026)', () => {
  const view = of(ready({ feePaidBy: 'tipme', feeMinor: '0' }));
  assert.equal(view.canWithdraw, true);
  assert.equal(
    view.notice.body,
    'You can withdraw ₦1,800 to GTBank ••1234. Withdrawals are free: you receive the whole amount.',
  );
  assert.doesNotMatch(view.notice.body, /₦50|transfer fee/);
});

test('the withdraw screen shows “Free” for the fee when TipMe pays, and no fee-difference note', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(
    new URL('../src/app/dashboard/withdraw/withdraw-view.tsx', import.meta.url),
    'utf8',
  );
  assert.match(src, /figures\.feePaidBy === 'tipme' \? \(\s*'Free'/);
  assert.doesNotMatch(src, /Paid by TipMe/);
});

test('the 3rd withdrawal of the day says plainly that the transfer fee comes off it', () => {
  const personal = (over) =>
    ready({ feePaidBy: 'user', freePerDay: 2, ordinalToday: 3, ...over });
  assert.equal(
    withdrawDayNote(personal()),
    'This is your 3rd withdrawal today, so the ₦50 transfer fee comes off it. Withdrawals are free twice a day.',
  );
  assert.match(
    withdrawDayNote(personal({ ordinalToday: 4 })),
    /your 4th withdrawal today/,
  );
  assert.match(
    withdrawDayNote(personal({ ordinalToday: 11 })),
    /your 11th withdrawal/,
  );
  assert.match(
    withdrawDayNote(personal({ ordinalToday: 12 })),
    /your 12th withdrawal/,
  );
  assert.match(
    withdrawDayNote(personal({ ordinalToday: 23 })),
    /your 23rd withdrawal/,
  );
  // The first two are free: no note. A business has no daily allowance: no note.
  assert.equal(
    withdrawDayNote(
      ready({ feePaidBy: 'tipme', freePerDay: 2, ordinalToday: 2 }),
    ),
    null,
  );
  assert.equal(
    withdrawDayNote(ready({ freePerDay: 0, ordinalToday: 1 })),
    null,
  );
  assert.equal(withdrawDayNote(ready()), null);
  assert.equal(withdrawDayNote({ state: 'no_destination' }), null);
});

// You collect (owner, 23 Nov 2026; ADR-0016): each tip's share moves to the recipient's own account
// and is withdrawn from there. A verified collect recipient with nothing to withdraw is told what is
// on its way and where withdrawals go, never shown ₦0 and a Withdraw key.
const collect = (over = {}) => ({
  verified: true,
  readdBank: false,
  bank: { state: 'verified', bankName: 'Opay', last4: '5629' },
  onItsWayMinor: '570950000',
  refundHeldMinor: '0',
  disputeHeldMinor: '0',
  newAccountDelay: { hours: 24, until: '2026-11-30T10:00:00.000Z' },
  ...over,
});
const collectView = (over = {}, availableMinor = '0', extra = {}) =>
  collectWithdrawView({ collect: collect(over), availableMinor, ...extra });

test('collect, money on its way: the amount once, a lamp that says when it can go, the bank on the chip', () => {
  assert.deepEqual(collectView(), {
    figure: { caption: 'On its way to you', minor: '570950000' },
    lamp: { tone: 'amber', text: 'You can withdraw it once it arrives.' },
    lines: ['New accounts’ tips arrive 24 hours after they’re received.'],
    bank: 'Withdrawals go to Opay ••5629',
    warning: null,
  });
});

test('collect words never say the money goes straight to the bank', () => {
  const view = collectView();
  for (const text of [view.lamp.text, ...view.lines, view.bank])
    assert.doesNotMatch(text, /on its way to (Opay|your bank)|^To /);
});

test('collect: the delay line is built from the settings, and left out when none applies', () => {
  assert.deepEqual(
    collectView({ newAccountDelay: { hours: 1, until: 'x' } }).lines,
    ['New accounts’ tips arrive 1 hour after they’re received.'],
  );
  assert.deepEqual(
    collectView({ newAccountDelay: { hours: 48, until: 'x' } }).lines,
    ['New accounts’ tips arrive 48 hours after they’re received.'],
  );
  assert.deepEqual(collectView({ newAccountDelay: null }).lines, []);
});

test('collect, nothing on its way: nothing to withdraw, and no delay line about money that isn’t there', () => {
  assert.deepEqual(collectView({ onItsWayMinor: '0' }), {
    figure: { caption: 'Available', minor: '0' },
    lamp: { tone: 'off', text: 'Nothing to withdraw right now' },
    lines: ['You have nothing to withdraw yet.'],
    bank: 'Withdrawals go to Opay ••5629',
    warning: null,
  });
});

test('collect: money held for a refund or a dispute is said on its own line', () => {
  assert.deepEqual(
    collectView({
      refundHeldMinor: '300000',
      disputeHeldMinor: '250000',
      newAccountDelay: null,
    }).lines,
    [
      '₦3,000 is held while a refund is settled.',
      'A payment to you is being questioned. We’ve held ₦2,500 until it’s settled.',
    ],
  );
});

test('collect without a bank on record has no chip', () => {
  assert.equal(collectView({ bank: null }).bank, null);
});

test('collect: a withdrawal hold the quote reports is said, with today’s words', () => {
  assert.deepEqual(
    collectView({}, '0', { quote: { state: 'paused', reason: 'reversal' } })
      .warning,
    {
      title: 'Withdrawals are paused',
      body: 'Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz',
    },
  );
  assert.equal(
    collectView({}, '0', { quote: ready({ withdrawableMinor: '0' }) }).warning,
    null,
  );
});

test('collect: today’s Withdraw screen stays for a balance, the bank form, and everyone else', () => {
  // A balance (arrived, or from before You collect) can be withdrawn.
  assert.equal(collectView({}, '180000'), null);
  // Not verified yet, or adding the bank again: the add-bank-details form says what to do.
  assert.equal(collectView({ verified: false }), null);
  assert.equal(collectView({ readdBank: true }), null);
  // Not on You collect.
  assert.equal(
    collectWithdrawView({ collect: null, availableMinor: '0' }),
    null,
  );
});

test('collect: a withdrawal just requested (or one we couldn’t confirm) keeps today’s screen, so its slip stays', () => {
  // The whole balance was withdrawn: the reload reads ₦0, but the outcome must still be said.
  assert.equal(collectView({}, '0', { outcomeShown: true }), null);
});

test('the delay line on today’s screen: only with money on its way while the delay applies', () => {
  assert.equal(
    collectDelayLine(collect()),
    'New accounts’ tips arrive 24 hours after they’re received.',
  );
  assert.equal(collectDelayLine(collect({ onItsWayMinor: '0' })), null);
  assert.equal(collectDelayLine(collect({ newAccountDelay: null })), null);
  assert.equal(collectDelayLine(null), null);
});

test('collect words never name the payment partner', () => {
  const view = collectView({
    refundHeldMinor: '300000',
    disputeHeldMinor: '250000',
  });
  for (const text of [view.lamp.text, ...view.lines, view.bank])
    assert.doesNotMatch(text, /bachs|paystack|flutterwave/i);
});

test('a request’s answer reads as its parts: just asked for is on its way', () => {
  assert.equal(
    requestParts([{ payoutId: 'a', amountMinor: '1', status: 'REQUESTED' }]),
    null,
  );
  const parts = requestParts([
    { payoutId: 'a', amountMinor: '372000', status: 'REQUESTED' },
    { payoutId: 'b', amountMinor: '228000', status: 'PROCESSING' },
    { payoutId: 'c', amountMinor: '1000', status: 'PAID' },
    { payoutId: 'd', amountMinor: '1000', status: 'FAILED' },
  ]);
  assert.deepEqual(
    parts.map((part) => part.state),
    ['requested', 'processing', 'sent', 'failed'],
  );
  assert.equal(partsView(parts.slice(0, 2)).parts[0].words, 'on its way');
});
