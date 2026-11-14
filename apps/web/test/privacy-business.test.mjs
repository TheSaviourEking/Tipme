import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// TipMe for businesses, plan B9 Task 24: the privacy page says what a business sees before
// BUSINESS_ENABLED is turned on. Plain facts only: no claim of approval, and no provider name.
const page = readFileSync(
  new URL('../src/app/legal/privacy/page.tsx', import.meta.url),
  'utf8',
);
// The words a reader sees, with JSX line breaks and {' '} joins folded into single spaces.
const words = page
  .replace(/\{' '\}/g, ' ')
  .replace(/\s+/g, ' ')
  .replace(/[’]/g, "'");

test('the privacy page has a section for supporters tipping at a business', () => {
  assert.match(
    words,
    /<h2 id="business-tipping">If you tip at a business<\/h2>/,
  );
  for (const fact of [
    /how many tips each person received, the tags and notes supporters chose to leave, and its busiest hours/,
    /never sees your name, your contact details, your message to the person, the exact time you tipped or your payment reference/,
    /Fewer than 3/,
    /date only, never the time/,
  ])
    assert.match(words, fact);
});

test('the privacy page has a section for people who work at a business', () => {
  assert.match(
    words,
    /<h2 id="business-working">If you work at a business<\/h2>/,
  );
  for (const fact of [
    /the name you choose to show and, if you choose, your photo/,
    /amounts only if you choose to share them/,
    /when you leave/i,
    /download/i,
  ])
    assert.match(words, fact);
});

test('the business sections claim no approval and name no provider', () => {
  const sections = words.slice(words.indexOf('business-tipping'));
  assert.doesNotMatch(
    sections,
    /\b(approved|licensed|licence|regulated|regulator|authori[sz]ed)\b/i,
  );
  assert.doesNotMatch(sections, /bachs|paystack|flutterwave/i);
});

test('the privacy page says a business may show its logo, and owners can remove it', () => {
  // Business logos (#179): an owner's square logo shows on the public business, location and
  // staff pages, stored like page photos.
  const sections = words.slice(words.indexOf('business-tipping'));
  assert.match(sections, /A business may show its logo on its public pages/);
  assert.match(sections, /its owners can remove it at any time/);
});
