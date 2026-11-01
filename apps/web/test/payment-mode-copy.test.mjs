import assert from 'node:assert/strict';
import { test } from 'node:test';
import { paymentModeCopy } from '../src/lib/payment-mode-copy.ts';

const testWords = /test|sandbox|no real money/i;

// Closed and live copies run Bachs live: no page there may call it a test.
for (const mode of ['closed', 'live']) {
  test(`${mode} copy never says test, sandbox or no real money`, () => {
    const copy = paymentModeCopy(mode);
    for (const [key, text] of Object.entries(copy))
      if (typeof text === 'string')
        assert.doesNotMatch(text, testWords, `${mode}.${key}`);
  });
}

test('test copy keeps today’s wording', () => {
  const copy = paymentModeCopy('test');
  assert.equal(copy.dashboardBadge, 'Test mode');
  assert.equal(copy.formBadge, 'Test payments');
  assert.equal(
    copy.formDisclaimer,
    'TipMe is in test mode: no real money moves yet.',
  );
  assert.equal(
    copy.signUpLede,
    'An email address and a handle is all it takes to start receiving thanks. Payments are in test mode.',
  );
  assert.equal(
    copy.profileSafety,
    'No account needed. TipMe is in test mode: no real money moves yet.',
  );
  assert.equal(
    copy.withdrawNotice,
    'No real money moves in test mode. The test bank pays straight away.',
  );
  assert.equal(copy.receiptBanner, 'Test payment · no real money moved');
  assert.equal(copy.footerNote, 'Development preview · Test mode');
});

test('closed copy says tipping opens soon where a supporter would pay', () => {
  const copy = paymentModeCopy('closed');
  assert.equal(copy.payable, false);
  assert.equal(copy.closedTitle, 'Tipping opens soon');
  assert.match(copy.profileSafety, /Tipping opens soon/);
  assert.match(copy.homeClarity, /Tipping opens soon/);
  assert.match(copy.howItWorksPay, /Tipping opens soon/);
  assert.equal(copy.formBadge, null);
  assert.equal(copy.dashboardBadge, null);
});

test('only test and live copies show a pay button', () => {
  assert.equal(paymentModeCopy('test').payable, true);
  assert.equal(paymentModeCopy('live').payable, true);
  assert.equal(paymentModeCopy('live').formBadge, null);
  assert.equal(paymentModeCopy('live').receiptBanner, null);
});
