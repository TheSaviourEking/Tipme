import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  HOME_DESCRIPTION,
  SHARE_CARD_ALT,
  SITE_DESCRIPTION,
  paymentModeCopy,
} from '../src/lib/payment-mode-copy.ts';

const testWords =
  /test|sandbox|no real money|not a promise of payment|non-transactional/i;

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
  assert.match(copy.formTrust, /^No account needed\./);
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
  assert.equal(copy.formTrust, null);
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

test('metadata shown in every mode never claims a test or a preview without payments', () => {
  assert.doesNotMatch(SITE_DESCRIPTION, testWords);
  assert.doesNotMatch(HOME_DESCRIPTION, testWords);
  assert.doesNotMatch(SHARE_CARD_ALT, testWords);
  assert.doesNotMatch(SHARE_CARD_ALT, /preview|no real payments/i);
});

// Metadata reachable on closed and live copies: the shared site name, and /about-preview's
// (it redirects home outside test mode, but its tags must still be neutral). Those modules need
// the Next bundler to import, so the test reads their source.
test('shared metadata never says preview', () => {
  const metadata = readFileSync(
    new URL('../src/lib/metadata.ts', import.meta.url),
    'utf8',
  );
  assert.match(metadata, /siteName:\s*'TipMe'\s*[,}]/);
  const about = readFileSync(
    new URL('../src/app/about-preview/page.tsx', import.meta.url),
    'utf8',
  );
  const start = about.indexOf('previewMetadata(') + 'previewMetadata('.length;
  const tags = about.slice(start, about.indexOf(');', start));
  // The path is a URL, not text a visitor reads.
  assert.doesNotMatch(
    tags.replace(/'\/about-preview'/, ''),
    /preview|development/i,
  );
});

// /about-preview, the demo pay form and demo links describe a test copy: reachable only there.
test('preview pages and the demo pay form are for test copies only', () => {
  assert.equal(paymentModeCopy('test').previewPages, true);
  assert.equal(paymentModeCopy('test').homeDemo, 'form');
  for (const mode of ['closed', 'live'])
    assert.equal(paymentModeCopy(mode).previewPages, false, mode);
  assert.equal(paymentModeCopy('closed').homeDemo, 'closed');
  assert.equal(paymentModeCopy('live').homeDemo, 'example');
});
