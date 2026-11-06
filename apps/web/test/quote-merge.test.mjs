import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeLocalQuote, withdrawalInFlight } from '../src/lib/quote-merge.ts';

// Live updates never make a call to the payment partner: a signal reads only TipMe's side of the
// quote (`?scope=local`), and this decides what the page then shows.
const ready = {
  state: 'ready',
  withdrawableMinor: '500000',
  ledgerMinor: '900000',
  providerMinor: '500000',
  feeMinor: '0',
  destination: { bankName: 'GTBank', last4: '6789' },
  inReview: false,
};

test('a local answer that blocks replaces whatever was shown', () => {
  const paused = { state: 'paused', reason: 'switched_off', inReview: false };
  assert.deepEqual(mergeLocalQuote(ready, paused), {
    quote: paused,
    needsCheck: false,
  });
});

test('unchecked after a ready quote keeps its figures, with the new in-review flag', () => {
  assert.deepEqual(
    mergeLocalQuote(ready, { state: 'unchecked', inReview: true }),
    { quote: { ...ready, inReview: true }, needsCheck: false },
  );
});

test('unchecked after a block (or nothing) needs a full check the person asks for', () => {
  for (const previous of [
    null,
    { state: 'paused', reason: 'switched_off', inReview: false },
    { state: 'destination_pending', inReview: false },
    { state: 'provider_unavailable', inReview: false },
  ])
    assert.deepEqual(
      mergeLocalQuote(previous, { state: 'unchecked', inReview: false }),
      { quote: null, needsCheck: true },
      JSON.stringify(previous),
    );
});

test('a withdrawal is in flight while one is requested, on its way or being checked', () => {
  const row = (state) => ({ state });
  assert.equal(withdrawalInFlight([row('sent'), row('failed')]), false);
  for (const state of ['requested', 'processing', 'in_review'])
    assert.equal(withdrawalInFlight([row('sent'), row(state)]), true, state);
  assert.equal(withdrawalInFlight(null), false);
});
