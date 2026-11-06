import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  withdrawableNow,
  withdrawFee,
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
  destination: { bankName: 'GTBank', last4: '1234' },
  inReview: false,
  ...over,
});
const of = (quote, available = true) =>
  withdrawState({ withdrawalsAvailable: available, quote });

test('ready says where the money goes and who pays the fee', () => {
  const view = of(ready());
  assert.equal(view.canWithdraw, true);
  assert.equal(
    view.notice.body,
    'You can withdraw ₦1,800 to GTBank ••1234. TipMe pays the ₦50 transfer fee.',
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

test('tips collected elsewhere are never read as a balance we cannot check', () => {
  const view = of({ state: 'provider_unavailable', inReview: false }, false);
  assert.equal(view.kind, 'collected_elsewhere');
  assert.equal(view.canWithdraw, false);
  assert.doesNotMatch(view.notice.body, /can’t check your balance/);
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
    'WITHDRAWAL_UNAVAILABLE',
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
  assert.equal(now(ready(), '1000000', false), BigInt(0));
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
    'WITHDRAWAL_UNAVAILABLE',
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
  assert.equal(withdrawFee(ready()), 'TipMe pays the ₦50 transfer fee.');
  assert.equal(withdrawFee(ready({ feeMinor: '0' })), null);
  assert.equal(withdrawFee({ state: 'no_destination', inReview: false }), null);
  assert.equal(withdrawFee(null), null);
});
