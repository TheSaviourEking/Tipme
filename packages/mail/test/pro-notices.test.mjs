import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAIL_TYPES, renderMail } from '../dist/index.js';
import { preheaderOf } from './preheader.mjs';

// Paid Pro (ADR-0015): reminders, grace and the end of Pro. No amount, and no partner name, in a
// subject or preview line; the price comes from the server in the data.
const ctx = { webOrigin: 'https://usetipme.xyz', unsubscribeUrl: null };
const IDS = ['pro_renewal_reminder', 'pro_grace_started', 'pro_ended'];

test('the Pro notices are registered, account mail that cannot be turned off', () => {
  for (const id of IDS) {
    assert.ok(MAIL_TYPES[id], id);
    assert.equal(MAIL_TYPES[id].category, 'account');
    assert.equal(MAIL_TYPES[id].preference, null);
  }
});

test('the reminder shows the month’s end date and the current price, and never the partner', () => {
  const out = renderMail(
    'pro_renewal_reminder',
    {
      daysLeft: 7,
      endDate: '9 December 2026',
      graceEndDate: '12 December 2026',
      priceMinor: '250000',
    },
    ctx,
  );
  assert.match(out.text, /9 December 2026/);
  assert.match(out.text, /₦2,500 a month/);
  assert.match(out.text, /12 December 2026/);
  for (const id of IDS) {
    const rendered = renderMail(id, MAIL_TYPES[id].sample, ctx);
    for (const part of [rendered.subject, rendered.text, rendered.html])
      assert.doesNotMatch(part, /bachs/i, id);
    assert.doesNotMatch(rendered.subject, /₦|NGN|\d{3}/, `${id} subject`);
    assert.doesNotMatch(
      preheaderOf(rendered.html) ?? '',
      /₦|NGN/,
      `${id} preheader`,
    );
  }
});

test('one day left says tomorrow; without a price the reminder names none', () => {
  const out = renderMail(
    'pro_renewal_reminder',
    {
      daysLeft: 1,
      endDate: '9 December 2026',
      graceEndDate: '12 December 2026',
    },
    ctx,
  );
  assert.match(out.text, /tomorrow/);
  assert.doesNotMatch(out.text, /₦/);
});

test('grace and ending say what happens and that nothing is deleted', () => {
  const grace = renderMail(
    'pro_grace_started',
    { graceEndDate: '12 December 2026' },
    ctx,
  );
  assert.match(grace.text, /12 December 2026/);
  const ended = renderMail('pro_ended', {}, ctx);
  assert.match(ended.text, /nothing is deleted/i);
});

test('the Pro receipt: period, amount and how it was paid, no amount in subject or preview, no partner name', () => {
  const out = renderMail(
    'pro_receipt',
    {
      amountMinor: '250000',
      paidBy: 'bank_transfer',
      startDate: '9 November 2026',
      endDate: '9 December 2026',
      purchaseRef: 'c0de1234',
    },
    ctx,
  );
  assert.equal(out.subject, 'Your TipMe Pro receipt');
  assert.match(out.text, /₦2,500/);
  assert.match(out.text, /9 November 2026/);
  assert.match(out.text, /9 December 2026/);
  assert.match(out.text, /bank transfer through our payment partner/);
  assert.doesNotMatch(out.text + out.html, /bachs/i);
  assert.doesNotMatch(preheaderOf(out.html) ?? '', /₦|NGN/);
  assert.equal(MAIL_TYPES.pro_receipt.category, 'account');
});
