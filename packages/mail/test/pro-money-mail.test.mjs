import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIL_TYPES, renderMail } from '../dist/index.js';
import { preheaderOf } from './preheader.mjs';

// Paid Pro, plan Tasks 8 and 10: a receipt for a month paid from the TipMe balance or by the saved
// card, and the note when an automatic renewal didn't go through. No amount or partner name in a
// subject or preview line.
const ctx = { webOrigin: 'https://usetipme.xyz', unsubscribeUrl: null };
const receipt = (paidBy) => ({
  ...MAIL_TYPES.pro_receipt.sample,
  paidBy,
});

test('a balance receipt says it was paid from the TipMe balance', () => {
  const out = renderMail('pro_receipt', receipt('balance'), ctx);
  assert.match(out.text, /your TipMe balance/);
  assert.doesNotMatch(out.text, /bachs/i);
});

test('a saved-card receipt says it renewed automatically and how to turn that off', () => {
  const out = renderMail('pro_receipt', receipt('saved_card'), ctx);
  assert.match(out.text, /saved card/);
  assert.match(out.text, /Turn off auto-renew/);
});

test('pro_renewal_failed is account mail: the card didn’t go through, Pro stays until grace ends, Renew', () => {
  const type = MAIL_TYPES.pro_renewal_failed;
  assert.ok(type);
  assert.equal(type.category, 'account');
  assert.equal(type.preference, null);
  const out = renderMail('pro_renewal_failed', type.sample, ctx);
  assert.match(out.text, /didn’t go through/);
  assert.match(out.text, /12 December 2026/);
  assert.match(out.text, /\/dashboard\/settings/);
  for (const part of [out.subject, out.text, out.html])
    assert.doesNotMatch(part, /bachs/i);
  assert.doesNotMatch(out.subject, /₦|NGN|\d{3}/);
  assert.doesNotMatch(preheaderOf(out.html) ?? '', /₦|NGN/);
});
