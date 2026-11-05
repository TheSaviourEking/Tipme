import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withdrawableNow, withdrawState } from '../src/lib/withdraw-state.ts';

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
  const review = 'Your withdrawal is being checked by the payment provider.';
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
