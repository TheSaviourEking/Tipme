import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentAccountCopy } from '../src/lib/payment-account-copy.ts';

// A bachs-live copy pays real recipients: nothing on the card may call it a test.
test('the live payment account card never says test, sandbox or no real money', () => {
  const live = paymentAccountCopy('live');
  for (const [key, text] of Object.entries(live))
    assert.doesNotMatch(text, /test|sandbox|no real money/i, key);
  assert.match(live.intro, /your tips are paid into/);
  assert.match(live.intro, /our payment partner/);
});

test('the sandbox card keeps its test wording', () => {
  assert.deepEqual(paymentAccountCopy('sandbox'), {
    heading: 'Test payments',
    intro:
      'Sandbox only: no real money moves. Set up a test payment account so supporters can tip you during testing.',
    ready: 'Ready to receive test tips',
    setUp: 'Set up test payments',
    verifyEmailFirst:
      'Verify your email address first, then set up test payments.',
  });
});

test('before the environment is known the card names no environment', () => {
  const unknown = paymentAccountCopy(null);
  for (const [key, text] of Object.entries(unknown))
    assert.doesNotMatch(text, /test|sandbox|no real money/i, key);
});
