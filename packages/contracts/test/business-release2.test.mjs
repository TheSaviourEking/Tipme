import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  apiErrorCodes,
  ISSUE_KINDS,
  SHARE_OPTIONS_BPS,
  shareCounterSchema,
  shareProposalSchema,
  shareReportSchema,
  tableCardAssignSchema,
  tableCardCreateSchema,
  TABLE_CARD_CODE,
  teamTipIntentRequestSchema,
  teamTipQuoteRequestSchema,
} from '../dist/index.js';

// Business release 2 (plan R2-0 Task 27): the shapes R2-A to R2-E share.

const id = '00000000-0000-4000-8000-000000000001';

test('a proposal takes only the owner’s options, capped at 50%', () => {
  assert.deepEqual([...SHARE_OPTIONS_BPS], [0, 1000, 2000, 3000, 5000]);
  for (const businessBps of SHARE_OPTIONS_BPS) {
    assert.ok(
      shareProposalSchema.safeParse({ memberId: id, businessBps }).success,
    );
    assert.ok(shareCounterSchema.safeParse({ businessBps }).success);
  }
  for (const businessBps of [500, 4000, 6000, 10000, '1000', -1000])
    assert.equal(
      shareProposalSchema.safeParse({ memberId: id, businessBps }).success,
      false,
      String(businessBps),
    );
  assert.equal(
    shareProposalSchema.safeParse({ memberId: id, businessBps: 1000, x: 1 })
      .success,
    false,
  );
});

test('a report to TipMe has a known reason and optional short text', () => {
  assert.ok(shareReportSchema.safeParse({ reason: 'pressure' }).success);
  assert.ok(
    shareReportSchema.safeParse({ reason: 'other', body: 'They insisted.' })
      .success,
  );
  assert.equal(shareReportSchema.safeParse({ reason: 'angry' }).success, false);
  assert.equal(
    shareReportSchema.safeParse({ reason: 'other', body: 'x'.repeat(281) })
      .success,
    false,
  );
});

test('team tips: a location and an amount; the intent carries no message or member', () => {
  assert.ok(
    teamTipQuoteRequestSchema.safeParse({
      locationId: id,
      amountMinor: '200000',
      currency: 'NGN',
    }).success,
  );
  assert.equal(
    teamTipQuoteRequestSchema.safeParse({
      locationId: id,
      amountMinor: '2.5',
      currency: 'NGN',
    }).success,
    false,
  );
  assert.ok(teamTipIntentRequestSchema.safeParse({ quoteId: id }).success);
  assert.equal(
    teamTipIntentRequestSchema.safeParse({ quoteId: id, message: 'hi' })
      .success,
    false,
  );
  assert.equal(
    teamTipIntentRequestSchema.safeParse({ quoteId: id, businessMemberId: id })
      .success,
    false,
  );
});

test('table cards: a short label, a member to assign, a 10-character base32 code', () => {
  assert.ok(tableCardCreateSchema.safeParse({ label: 'Table 4' }).success);
  assert.equal(
    tableCardCreateSchema.safeParse({ label: 'x'.repeat(21) }).success,
    false,
  );
  assert.ok(tableCardAssignSchema.safeParse({ memberId: id }).success);
  assert.ok(TABLE_CARD_CODE.test('abcdefgh23'));
  assert.equal(TABLE_CARD_CODE.test('abcdefgh01'), false);
});

test('release 2 error codes and issue kinds exist', () => {
  for (const code of [
    'SHARE_NOT_ALLOWED',
    'SHARE_CHANGE_TOO_SOON',
    'SHARE_NOT_OPEN',
    'TEAM_NOBODY_ON_SHIFT',
    'CARD_NOT_FOUND',
    'BALANCE_BELOW_ZERO',
  ])
    assert.ok(apiErrorCodes.includes(code), code);
  assert.ok(ISSUE_KINDS.includes('share_report'));
  assert.ok(ISSUE_KINDS.includes('balance_below_zero'));
});
