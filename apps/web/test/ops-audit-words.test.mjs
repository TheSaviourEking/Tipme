import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { auditWords, fallback, words } from '../src/lib/ops-audit-words.ts';

// The same encoding as withAuditChange in packages/database/src/operations/staff.ts.
const withChange = (reason, change) =>
  `${reason} [change: ${JSON.stringify(change)}]`;

const A = '0b1e4d6a-1111-4c2d-8e3f-00000000a1b2';
const B = '0b1e4d6a-2222-4c2d-8e3f-00000000c3d4';
const WHY = 'Turning it on for the pilot group';

const detail = (action, change, subjectId = 'x') =>
  auditWords({ action, subjectId, reason: withChange(WHY, change) });

const noJson = (text) => {
  assert.ok(!/[{}"]/.test(text), `raw JSON in: ${text}`);
  assert.ok(!/\[change:/.test(text), `marker in: ${text}`);
};

// Every action that writes a change record today, with the shape it writes, and the words staff see.
const CASES = [
  [
    'feature_switch.set',
    'page_studio',
    { from: false, to: true, approvedBy: B },
    'Switch page_studio: off → on; approved by staff …00c3d4',
  ],
  [
    'feature_switch.set',
    'live',
    { from: null, to: false, approvedBy: null },
    'Switch live: not set → off',
  ],
  [
    'display_setting.set',
    'pro_badge',
    { from: 'unset', to: 'shown' },
    'Setting pro_badge: unset → shown',
  ],
  [
    'pro.price_changed',
    'p',
    { from: '250000', to: '500000', approvedBy: B },
    'Pro price: ₦2,500 → ₦5,000 a month; approved by staff …00c3d4',
  ],
  [
    'plan_fees.changed',
    'plan_fee_rates',
    {
      from: { freeBps: '700', proBps: '500' },
      to: { freeBps: '500', proBps: '300' },
      approvedBy: B,
    },
    'TipMe’s fee per plan: Free 7%, Pro 5% → Free 5%, Pro 3%; approved by staff …00c3d4',
  ],
  [
    'collect_settings.changed',
    'c',
    {
      from: { capMinor: '5000000', capDays: 30, reminderDays: [7, 21, 28] },
      to: { capMinor: '10000000', capDays: 30, reminderDays: [7, 14, 28] },
      approvedBy: B,
    },
    'You collect limits: holding cap ₦50,000 → ₦100,000, reminders days 7, 21, 28 → days 7, 14, 28; approved by staff …00c3d4',
  ],
  [
    'collect_transfers.paused',
    'c',
    { from: false, to: true, approvedBy: null },
    'You collect transfers paused',
  ],
  [
    'collect_transfers.resumed',
    'c',
    { from: true, to: false, approvedBy: B },
    'You collect transfers resumed; approved by staff …00c3d4',
  ],
  [
    'business_pro.price_changed',
    'p',
    { from: null, to: '700000', approvedBy: null },
    'Business Pro price: not set → ₦7,000 a month',
  ],
  [
    'username.released',
    'amaka',
    { takeBackId: A },
    'Was held for take-back …00a1b2',
  ],
  [
    'username.handover_link_created',
    'mtn',
    { reservationId: A, linkId: B, expiresAt: '2026-12-02T10:00:00.000Z' },
    'Claim link …00c3d4 for reservation …00a1b2, until 2 December 2026',
  ],
  [
    'username.handover_link_created',
    'mtn',
    {
      reservationId: A,
      linkId: B,
      expiresAt: '2026-12-02T10:00:00.000Z',
      replacedLinkId: A,
    },
    'Claim link …00c3d4 for reservation …00a1b2, until 2 December 2026; replaced link …00a1b2',
  ],
  [
    'username.account_lookup',
    '12 characters',
    { by: 'email', found: [A] },
    'Looked up by email; found account …00a1b2',
  ],
  [
    'username.account_lookup',
    '5 characters',
    { by: 'username', found: [] },
    'Looked up by username; found nobody',
  ],
  [
    'username.handover_link_cancelled',
    'mtn',
    {
      reservationId: A,
      linkId: B,
      makerId: A,
      triggeredBy: B,
      trigger: 'staff.role_updated',
    },
    'Claim link …00c3d4 for reservation …00a1b2; ended automatically after a role edit by staff …00c3d4',
  ],
  [
    'username.handover_link_cancelled',
    'mtn',
    { reservationId: A, linkId: B },
    'Claim link …00c3d4 for reservation …00a1b2',
  ],
  [
    'username.claimed_via_link',
    'mtn',
    {
      reservationId: A,
      linkId: B,
      linkCreatedBy: B,
      profileId: A,
      previous: 'kemi',
    },
    'Claimed through link …00c3d4 (reservation …00a1b2) by page …00a1b2, which was @kemi; link made by staff …00c3d4',
  ],
  [
    'username.claimed_via_link',
    'mtn',
    {
      reservationId: A,
      linkId: B,
      linkCreatedBy: B,
      profileId: A,
      previous: null,
    },
    'Claimed through link …00c3d4 (reservation …00a1b2) by page …00a1b2, a new page; link made by staff …00c3d4',
  ],
  [
    'username.assigned',
    'mtn',
    {
      reservationId: A,
      userId: B,
      profileId: A,
      previous: 'kemi',
      cancelledLinkId: B,
    },
    'Given to page …00a1b2, which was @kemi (reservation …00a1b2); cancelled link …00c3d4',
  ],
  [
    'username.assigned',
    'mtn',
    { reservationId: A, userId: B, profileId: A, previous: null },
    'Given to page …00a1b2, a new page (reservation …00a1b2)',
  ],
  [
    'username.free_change_used',
    'p',
    { takeBackId: A, from: 'old', to: 'new' },
    'Free change @old → @new (take-back …00a1b2)',
  ],
  [
    'username.take_back_started',
    'amaka',
    {
      takeBackId: A,
      requestedBy: A,
      approvedBy: B,
      category: 'trademark',
      noticeDays: 14,
      kind: 'current',
      profileId: B,
    },
    'Take-back …00a1b2 of a current name; category: trademark; 14 days’ notice; page …00c3d4; asked by staff …00a1b2; approved by staff …00c3d4',
  ],
  [
    'username.take_back_cancelled',
    'amaka',
    { takeBackId: A, stateBefore: 'notice_sent' },
    'Take-back …00a1b2, which was notice sent',
  ],
  [
    'username.take_back_done',
    'amaka',
    {
      takeBackId: A,
      outcome: 'user_chose',
      newHandle: 'amaka2',
      noticedVia: 'email',
    },
    'Take-back …00a1b2: user chose; new name @amaka2; notice seen by email',
  ],
  [
    'username.take_back_noticed',
    'amaka',
    { takeBackId: A, via: 'banner' },
    'Take-back …00a1b2: notice seen by banner',
  ],
  [
    'announcement.created',
    'a',
    { revision: 1, audience: 'everyone' },
    'Revision 1, for everyone',
  ],
  [
    'announcement.edited',
    'a',
    { revision: 3, fields: ['subject', 'bodyText'] },
    'Revision 3; changed subject, body text',
  ],
  ['announcement.test_sent', 'a', { revision: 2 }, 'Test of revision 2'],
  [
    'announcement.cancelled',
    'a',
    { was: 'sending', queued: 40, recipients: 100 },
    'Was sending; 40 of 100 emails queued',
  ],
  [
    'announcement.send_started',
    'a',
    {
      revision: 2,
      audience: 'pro_members',
      recipients: 100,
      askedBy: A,
      approvedBy: B,
    },
    'Revision 2 to pro members, 100 people; asked by staff …00a1b2; approved by staff …00c3d4',
  ],
  [
    'announcement.sent',
    'a',
    { queued: 100, recipients: 100 },
    '100 of 100 emails queued',
  ],
  [
    'role.created',
    'r',
    { name: 'Support', permissions: ['people.view', 'issues.view'] },
    'Role “Support” with people.view, issues.view',
  ],
  [
    'role.updated',
    'r',
    {
      added: ['audit.view'],
      removed: [],
      name: { from: 'Support', to: 'Help' },
      description: { from: 'a', to: 'b' },
    },
    'added: audit.view; name: “Support” → “Help”; description changed',
  ],
  ['role.updated', 'r', { added: [], removed: [] }, 'No change to permissions'],
  [
    'role.deleted',
    'r',
    { name: 'Old', permissions: [] },
    'Role “Old”, which had no permissions',
  ],
  [
    'staff.access_changed',
    'u',
    {
      added: ['audit.view'],
      removed: ['refunds.run'],
      clearedAdditions: [],
      clearedRemovals: ['pro.price'],
    },
    'added: audit.view; removed: refunds.run; cleared removals: pro.price',
  ],
  [
    'staff.role_changed',
    'u',
    {
      from: { id: 'support', name: 'Support' },
      to: { id: 'finance', name: 'Finance' },
      gains: ['refunds.run'],
      losses: [],
    },
    'Role: Support → Finance; gains: refunds.run',
  ],
  [
    'staff.added',
    'u',
    {
      role: { id: 'support', name: 'Support' },
      permissions: ['people.view'],
      email: 'a•••@example.com',
      account: 'new',
      restored: false,
      recoveriesCancelled: 0,
      delivery: 'queued',
    },
    'Role Support; new account a•••@example.com; invitation queued',
  ],
  [
    'staff.invitation_resent',
    'u',
    { linkSentTo: 'a•••@example.com', delivery: 'suppressed' },
    'Link sent to a•••@example.com (suppressed)',
  ],
  [
    'staff.removed',
    'u',
    { role: { id: 'support', name: 'Support' }, losses: ['people.view'] },
    'Role Support; loses: people.view',
  ],
  [
    'staff.authenticator_reset',
    'u',
    {
      authenticatorRemoved: true,
      linkSentTo: 'a•••@example.com',
      delivery: 'queued',
    },
    'Authenticator removed; link sent to a•••@example.com (queued)',
  ],
  [
    'staff.invitation_declined',
    'u',
    {
      via: 'declined',
      role: { id: 'support', name: 'Support' },
      clearedAdditions: [],
      clearedRemovals: [],
    },
    'They declined; role Support',
  ],
  [
    'staff.owner_granted',
    'u',
    { from: null, to: 'owner', restored: false },
    'Role: none → owner',
  ],
  [
    'staff.release_check_granted',
    'u',
    { from: 'support', to: 'release_check', restored: true },
    'Role: support → release check; restored after removal',
  ],
  [
    'account.recovery_refused_staff',
    'u',
    { newEmail: 'n•••@example.com' },
    'Recovery to n•••@example.com refused',
  ],
  [
    'account.email_set_by_script',
    'u',
    {
      from: 'o•••@example.com',
      to: 'n•••@example.com',
      staff: false,
      oldAddressNotified: true,
    },
    'Email o•••@example.com → n•••@example.com; staff account: no; old address told: yes',
  ],
  [
    'changelog.edited',
    '42',
    { number: 42, revision: 2, fields: ['staffText', 'audience'] },
    '#42 revision 2; changed staff text, audience',
  ],
  [
    'changelog.approved',
    '42',
    {
      number: 42,
      revision: 2,
      audience: 'everyone',
      restored: true,
      askedBy: A,
    },
    '#42 revision 2 for everyone; shown again; asked by staff …00a1b2',
  ],
  ['changelog.withdrawn', '42', { number: 42, revision: 2 }, '#42 revision 2'],
];

const SUMMARY = 'Refund ₦5,000 on Pro payment …9f3e21';
const step = (extra) => ({
  action: 'pro.refund',
  summary: SUMMARY,
  requestedBy: A,
  ...extra,
});
const SERIOUS = [
  [
    'serious_action.requested',
    step({ approvedBy: null }),
    `Asked for approval: ${SUMMARY}`,
  ],
  [
    'serious_action.repeated',
    { action: 'pro.refund', summary: SUMMARY, requestedBy: A, alsoAskedBy: B },
    `Asked again: ${SUMMARY}; first asked by staff …00a1b2`,
  ],
  [
    'serious_action.ran_alone',
    step({ approvedBy: null, aloneReason: 'no_second_person', note: 'x' }),
    `Ran without a second person (none was available): ${SUMMARY}`,
  ],
  [
    'serious_action.approved',
    step({ approvedBy: B }),
    `Approved: ${SUMMARY}; asked by staff …00a1b2; approved by staff …00c3d4`,
  ],
  [
    'serious_action.ran',
    step({ approvedBy: B }),
    `Ran: ${SUMMARY}; asked by staff …00a1b2; approved by staff …00c3d4`,
  ],
  [
    'serious_action.rejected',
    step({ rejectedBy: B }),
    `Rejected: ${SUMMARY}; asked by staff …00a1b2; rejected by staff …00c3d4`,
  ],
  [
    'serious_action.cancelled',
    step({}),
    `Cancelled: ${SUMMARY}; asked by staff …00a1b2`,
  ],
  [
    'serious_action.expired',
    step({}),
    `Expired: ${SUMMARY}; asked by staff …00a1b2`,
  ],
  [
    'serious_action.stale',
    step({ approvedBy: B, why: 'facts_changed', detail: 'The balance moved' }),
    `It did not run: the facts changed after it was asked. Look again, and ask again if it’s still needed. ${SUMMARY}; The balance moved; asked by staff …00a1b2`,
  ],
];

for (const [action, subject, change, expected] of CASES)
  test(`${action} reads as words`, () => {
    const result = detail(action, change, subject);
    assert.equal(result.reason, WHY);
    assert.equal(result.detail, expected);
    noJson(result.detail);
  });

for (const [action, change, expected] of SERIOUS)
  test(`${action} reads as words, led by the summary`, () => {
    const result = detail(action, change, A);
    assert.equal(result.detail, expected);
    noJson(result.detail);
  });

test('an unknown shape falls back to a name: value list, never JSON', () => {
  const result = detail('something.new', {
    countBefore: 3,
    nested: { from: 'a', to: 'b' },
    tags: ['x', 'y'],
    flag: true,
    owner: A,
    missing: null,
    deep: { level: { name: 'Inner' }, other: 1 },
  });
  assert.equal(
    result.detail,
    'count before: 3; nested: a → b; tags: x, y; flag: yes; owner: …00a1b2; missing: none; deep: level: Inner; other: 1',
  );
  noJson(result.detail);
});

test('the fallback never shows a secret-looking field', () => {
  const text = fallback({
    token: 'tok_live_abc',
    apiKey: 'k',
    secret: 's',
    codeSha256: 'h',
    password: 'p',
    sessionId: 'z',
    kept: 'fine',
  });
  assert.equal(text, 'kept: fine');
});

test('a known action with an unexpected shape still never shows JSON', () => {
  const result = detail('role.updated', {
    name: 'not an object',
    added: 'oops',
  });
  noJson(result.detail);
});

test('a reason with no change record is shown as written', () => {
  assert.deepEqual(
    auditWords({
      action: 'payout.held',
      subjectId: 'x',
      reason: 'Checked the bank [outcome: ok]',
    }),
    { reason: 'Checked the bank [outcome: ok]', detail: null },
  );
  assert.deepEqual(auditWords({ action: 'x', subjectId: null, reason: null }), {
    reason: null,
    detail: null,
  });
});

test('a broken record says so instead of showing it', () => {
  const result = auditWords({
    action: 'feature_switch.set',
    subjectId: 'x',
    reason: `${WHY} [change: {"from":tru]`,
  });
  assert.deepEqual(result, {
    reason: WHY,
    detail: 'Details could not be read',
  });
  // Cut short (no closing bracket), or several records run together: still never shown raw.
  for (const reason of [
    `${WHY} [change: {"from":false,"to":true`,
    `${WHY} [change:${JSON.stringify({ to: 'owner' }).repeat(3)}]`,
  ])
    assert.deepEqual(
      auditWords({ action: 'staff.owner_granted', subjectId: 'x', reason }),
      { reason: WHY, detail: 'Details could not be read' },
    );
});

test('the record is found with or without a space after the marker', () => {
  const result = auditWords({
    action: 'feature_switch.set',
    subjectId: 'page_studio',
    reason: `${WHY} [change:{"from":false,"to":true}]`,
  });
  assert.deepEqual(result, {
    reason: WHY,
    detail: 'Switch page_studio: off → on',
  });
});

test('a system entry with only a change record has no separate reason', () => {
  const result = auditWords({
    action: 'announcement.sent',
    subjectId: 'a',
    reason: withChange('Every email of the announcement is queued', {
      queued: 2,
      recipients: 2,
    }),
  });
  assert.equal(result.reason, 'Every email of the announcement is queued');
  assert.equal(result.detail, '2 of 2 emails queued');
});

test('words splits camelCase and snake_case', () => {
  assert.equal(words('clearedAdditions'), 'cleared additions');
  assert.equal(words('page_studio'), 'page studio');
});

test('every action that writes a change record has its own sentence', () => {
  // Reads the server's callers, so a new action with a change record fails here until it has words.
  const dir = new URL(
    '../../../packages/database/src/operations/',
    import.meta.url,
  );
  const covered = new Set([
    ...CASES.map((c) => c[0]),
    ...SERIOUS.map((c) => c[0]),
  ]);
  const found = new Set();
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
    const code = readFileSync(new URL(name, dir), 'utf8');
    for (const call of code.split('recordAudit(').slice(1)) {
      const block = call.slice(0, call.indexOf('});') + 1);
      if (!block.includes('withAuditChange(')) continue;
      const from = block.indexOf('action:');
      const ends = ['permission:', 'subjectType:']
        .map((key) => block.indexOf(key, from))
        .filter((at) => at > 0);
      const head = block.slice(from, Math.min(...ends));
      for (const m of head.matchAll(/'([a-z_]+\.[a-z_]+)'/g)) found.add(m[1]);
    }
    // Closing an approval records close.event, named where each close is asked for.
    for (const m of code.matchAll(/event: '(serious_action\.[a-z_]+)'/g))
      found.add(m[1]);
  }
  assert.ok(found.size >= 40, `found only ${found.size}`);
  assert.deepEqual([...found].filter((a) => !covered.has(a)).sort(), []);
});
