import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ISSUE_KINDS,
  TAKE_BACK_CATEGORIES,
  TAKE_BACK_CATEGORY_WORDS,
  TAKE_BACK_FREE_CHANGE_MS,
  TAKE_BACK_NEVER_REACHED_MS,
  TAKE_BACK_REMINDER_MS,
  TAKE_BACK_WHY,
} from '../dist/index.js';

test('TAKE_BACK_WHY has a sentence for every category, with no em dash', () => {
  assert.deepEqual(
    [...TAKE_BACK_CATEGORIES],
    ['ordinary', 'impersonation', 'trademark', 'legal'],
  );
  for (const category of TAKE_BACK_CATEGORIES) {
    const why = TAKE_BACK_WHY[category];
    assert.match(why, /^[A-Z].*\.$/, category);
    assert.equal(/[\u2013\u2014]/.test(why), false, category);
    assert.ok(TAKE_BACK_CATEGORY_WORDS[category], category);
  }
  assert.equal(
    TAKE_BACK_WHY.ordinary,
    'We need it to protect a brand, a public figure or one of our own names.',
  );
  assert.equal(TAKE_BACK_CATEGORY_WORDS.legal, 'Required by law');
});

test('the take-back clocks', () => {
  assert.equal(TAKE_BACK_NEVER_REACHED_MS, 14 * 86_400_000);
  assert.equal(TAKE_BACK_FREE_CHANGE_MS, 30 * 86_400_000);
  assert.equal(TAKE_BACK_REMINDER_MS, 2 * 86_400_000);
});

test('the two take-back issue kinds exist', () => {
  assert.ok(ISSUE_KINDS.includes('username_take_back_unnoticed'));
  assert.ok(ISSUE_KINDS.includes('username_take_back_overdue'));
});

test('handover: a claim link lasts 14 days, and its code travels only in a body', async () => {
  const {
    HANDOVER_LINK_DAYS,
    CLAIM_LINK_PREFIX,
    claimLinkCodeSchema,
    opsHandoverAssignSchema,
    opsHandoverAccountsQuerySchema,
  } = await import('../dist/index.js');
  assert.equal(HANDOVER_LINK_DAYS, 14);
  assert.equal(CLAIM_LINK_PREFIX, '#claim=');
  const code = 'ABCDEFGHIJKLMNOPQRSTUVWX';
  assert.deepEqual(claimLinkCodeSchema.parse({ code }), { code });
  // Lower case is read as the same code; anything else is refused before the database.
  assert.deepEqual(claimLinkCodeSchema.parse({ code: code.toLowerCase() }), {
    code,
  });
  for (const bad of [
    '',
    'ABC',
    `${code}A`,
    'ABCDEFGHIJKLMNOPQRSTUVW1',
    code.replace('A', '-'),
  ])
    assert.equal(
      claimLinkCodeSchema.safeParse({ code: bad }).success,
      false,
      bad,
    );
  assert.equal(
    claimLinkCodeSchema.safeParse({ code, extra: 1 }).success,
    false,
  );
  const userId = '00000000-0000-4000-8000-000000000001';
  assert.equal(
    opsHandoverAssignSchema.safeParse({ userId, reason: 'The brand asked us' })
      .success,
    true,
  );
  assert.equal(
    opsHandoverAssignSchema.safeParse({
      userId: 'x',
      reason: 'The brand asked us',
    }).success,
    false,
  );
  assert.equal(
    opsHandoverAccountsQuerySchema.safeParse({ query: 'a' }).success,
    false,
  );
  assert.equal(
    opsHandoverAccountsQuerySchema.safeParse({ query: 'kemi@example.com' })
      .success,
    true,
  );
});
