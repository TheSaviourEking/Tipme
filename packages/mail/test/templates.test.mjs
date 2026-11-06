import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAIL_TYPES,
  mailLink,
  renderMail,
  MAIL_SENDERS,
  senderAddress,
} from '../dist/index.js';
import { preheaderOf } from './preheader.mjs';

const ctx = { webOrigin: 'https://usetipme.xyz', unsubscribeUrl: null };

test('every registered type renders subject, text and html from sample data', () => {
  const ids = Object.keys(MAIL_TYPES);
  assert.ok(ids.length >= 6);
  for (const id of ids) {
    const out = renderMail(id, MAIL_TYPES[id].sample, ctx);
    assert.ok(out.subject.length > 0, `${id} subject`);
    assert.ok(out.text.length > 0, `${id} text`);
    assert.match(out.html, /<html/i, `${id} html`);
  }
});

test('user text is escaped in HTML and intact in text', () => {
  const label = '<script>x</script> "Ada" 🎉 مرحبا';
  const out = renderMail(
    'tip_received',
    { ...MAIL_TYPES.tip_received.sample, supporterLabel: label },
    ctx,
  );
  assert.doesNotMatch(out.html, /<script/i);
  assert.match(out.html, /&quot;Ada&quot;/);
  assert.match(out.html, /🎉 مرحبا/);
  assert.ok(out.text.includes(label));
});

test('links carry their link key', () => {
  const url = mailLink(ctx, '/dashboard', 'open_dashboard');
  assert.equal(new URL(url).searchParams.get('ml'), 'open_dashboard');
  assert.equal(new URL(url).origin, 'https://usetipme.xyz');
  // A fragment stays a fragment, after the query.
  const withHash = mailLink(ctx, '/recover#r=abc', 'recover', true);
  assert.equal(new URL(withHash).hash, '#r=abc');
  assert.equal(new URL(withHash).searchParams.get('ml'), 'recover');
});

test('security mail has no snapshot', () => {
  const out = renderMail(
    'email_verification_link',
    MAIL_TYPES.email_verification_link.sample,
    ctx,
  );
  assert.equal(out.snapshot, null);
});

test('personal links are redacted in the snapshot', () => {
  const data = {
    ...MAIL_TYPES.provider_test.sample,
    token: 'secret-token-123',
  };
  const out = renderMail('provider_test', data, ctx);
  assert.ok(out.html.includes('secret-token-123'));
  assert.ok(out.snapshot);
  assert.ok(out.snapshot.html.includes('[personal link]'));
  assert.ok(!out.snapshot.html.includes('secret-token-123'));
  assert.ok(!out.snapshot.text.includes('secret-token-123'));
});

test('a type rejects data that fails its schema', () => {
  assert.throws(() => renderMail('tip_received', {}, ctx), {
    name: 'ZodError',
  });
});

test('security mail is never tracked; other mail is, unless the type says not', () => {
  assert.equal(MAIL_TYPES.email_verification_link.tracking, false);
  assert.equal(MAIL_TYPES.tip_received.tracking, true);
  assert.equal(MAIL_TYPES.provider_test.tracking, false);
});

test('every email type names a sender, and security mail always comes from security@', () => {
  for (const type of Object.values(MAIL_TYPES)) {
    assert.ok(MAIL_SENDERS[type.sender], `${type.id} has a known sender`);
    if (type.category === 'security')
      assert.equal(type.sender, 'security', type.id);
  }
  const at = (id) => MAIL_TYPES[id].sender;
  assert.equal(at('tip_received'), 'notifications');
  assert.equal(at('milestone'), 'notifications');
  assert.equal(at('withdrawal_paid'), 'payments');
  assert.equal(at('payment_account_ready'), 'payments');
  assert.equal(at('weekly_report'), 'reports');
  assert.equal(at('welcome'), 'hello');
  assert.equal(at('provider_test'), 'system');
});

test('a sender is an address on the mail domain with a branded name', () => {
  const brand = { domain: 'staging-mail.usetipme.xyz', name: 'TipMe Staging' };
  assert.deepEqual(senderAddress('security', brand), {
    address: 'security@staging-mail.usetipme.xyz',
    name: 'TipMe Staging Security',
  });
  assert.deepEqual(senderAddress('hello', brand), {
    address: 'hello@staging-mail.usetipme.xyz',
    name: 'TipMe Staging',
  });
  assert.deepEqual(
    senderAddress('notifications', {
      domain: 'mail.usetipme.xyz',
      name: 'TipMe',
    }),
    { address: 'notifications@mail.usetipme.xyz', name: 'TipMe Notifications' },
  );
});

test('one address can stand in for every sender, keeping each sender’s name', () => {
  const brand = {
    domain: 'staging-mail.usetipme.xyz',
    name: 'TipMe Staging',
    address: 'staging@usetipme.xyz',
  };
  assert.deepEqual(senderAddress('security', brand), {
    address: 'staging@usetipme.xyz',
    name: 'TipMe Staging Security',
  });
  assert.equal(
    senderAddress('notifications', brand).address,
    'staging@usetipme.xyz',
  );
});

test('a takeover release tells owners whether withdrawals really resumed', () => {
  const released = renderMail(
    'staff_freeze_released',
    { personHint: 'a•••@example.com', stillHeld: false },
    ctx,
  );
  assert.match(released.text, /can withdraw again/);
  const held = renderMail(
    'staff_freeze_released',
    { personHint: 'a•••@example.com', stillHeld: true },
    ctx,
  );
  assert.match(held.text, /still holds/);
  assert.doesNotMatch(held.text, /can withdraw again/);
});

/** Every string in a sample, at any depth, long enough to mean something. */
function sampleStrings(value, key = '') {
  if (typeof value === 'string')
    return value.length > 2 ? [{ key, value }] : [];
  if (Array.isArray(value)) return value.flatMap((v) => sampleStrings(v, key));
  if (value && typeof value === 'object')
    return Object.entries(value).flatMap(([k, v]) => sampleStrings(v, k));
  return [];
}

test('no sample value reaches a subject or preheader', () => {
  // The tip amount and the staff-only provider name are already in today's subjects.
  const allowed = {
    tip_received: ['netMinor'],
    provider_test: ['providerLabel'],
  };
  for (const [id, type] of Object.entries(MAIL_TYPES)) {
    const out = renderMail(id, type.sample, ctx);
    const pre = preheaderOf(out.html);
    // An enum's value is one of the template's own words ("cover"), not someone's data.
    const fixed = (key) =>
      ['enum', 'literal'].includes(type.schema.shape?.[key]?._zod?.def?.type);
    for (const { key, value } of sampleStrings(type.sample)) {
      if (allowed[id]?.includes(key) || fixed(key)) continue;
      assert.ok(!out.subject.includes(value), `${id} subject has ${key}`);
      assert.ok(!pre.includes(value), `${id} preheader has ${key}: ${pre}`);
    }
  }
});

/** Text a reader would see or copy: tags gone, entities read. */
const visible = (html) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<div data-preheader[\s\S]*?<\/div>/, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The visible text of every element whose opening tag matches `marker` (a class or style). */
const inside = (html, marker) =>
  [
    ...html.matchAll(
      new RegExp(`<(p|td)[^>]*${marker}[^>]*>([\\s\\S]*?)</\\1>`, 'g'),
    ),
  ].map((m) => visible(m[2]).trim());

const CODE_TYPES = [
  'sign_in_code',
  'email_change_code',
  'payout_destination_code',
  'recovery_email_code',
  'recovery_change_code',
  'recovery_code',
  'recovery_new_email_code',
];
const CODE_WARNING =
  'It works for 10 minutes. Never share it. TipMe staff will never ask for it.';

test('the sign-in code email reads as the board', () => {
  const out = renderMail('sign_in_code', { code: '482913' }, ctx);
  assert.equal(out.subject, 'Your TipMe sign-in code');
  assert.ok(
    out.text.startsWith(
      'Your sign-in code\n\nType it on TipMe to sign in.\n\n482913\n\n' +
        CODE_WARNING,
    ),
    out.text,
  );
  const code = /<!--code-->([\s\S]*?)<!--\/code-->/.exec(out.html);
  assert.equal(visible(code[1]), '482913', 'the code is in cells');
  assert.deepEqual(inside(out.html, 'tm-warn'), [CODE_WARNING]);
  for (const id of CODE_TYPES) {
    const mail = renderMail(id, { code: '482913' }, ctx);
    assert.ok(!mail.subject.includes('482913'), `${id} subject`);
    assert.equal(
      preheaderOf(mail.html),
      'Your code is inside. It works for 10 minutes.',
      `${id} preheader`,
    );
    assert.deepEqual(inside(mail.html, 'tm-warn'), [CODE_WARNING], id);
  }
  // The other six keep their own intro.
  assert.ok(
    renderMail('recovery_code', { code: '482913' }, ctx).text.includes(
      'Enter this code to move your TipMe account to a new sign-in email.',
    ),
  );
});

test('the welcome email lists the three steps in order, in html and text', () => {
  const out = renderMail('welcome', {}, ctx);
  const steps = [
    'Claim your username and add your face.',
    'Add the bank account your money goes to.',
    'Share your link or your QR code.',
  ];
  assert.ok(
    out.text.includes(
      'One link people can use to thank you with a tip. Three steps and you are ready:\n\n' +
        steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    ),
    out.text,
  );
  const seen = visible(out.html);
  const at = steps.map((s) => seen.indexOf(s));
  assert.ok(at.every((i) => i > 0));
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    'in order',
  );
  assert.ok(seen.indexOf(steps[2]) < seen.indexOf('Create your page'));
  assert.match(
    out.text,
    /Create your page: https:\/\/usetipme\.xyz\/sign-up\?/,
  );
});

test('confirm and recovery links say how long they work, in a quiet line', () => {
  const confirm = renderMail(
    'email_verification_link',
    MAIL_TYPES.email_verification_link.sample,
    ctx,
  );
  assert.ok(
    confirm.text.startsWith(
      'Confirm your email\n\nConfirm this address for your TipMe account, so we can reach you about your tips and your money.\n\nConfirm my email: https://usetipme.xyz/verify-email?ml=verify#v=',
    ),
    confirm.text,
  );
  assert.deepEqual(
    inside(confirm.html, 'tm-muted" style="margin:0;font-size:14px'),
    [
      'The link works for 24 hours. If you didn’t ask for this, ignore this email.',
    ],
  );
  assert.ok(
    confirm.text.includes(
      'You get this email because this address was added to a TipMe account.',
    ),
  );
  const recover = renderMail(
    'recovery_link',
    MAIL_TYPES.recovery_link.sample,
    ctx,
  );
  assert.ok(
    recover.text.startsWith(
      'Get back into TipMe\n\nLost your phone number? Attach a new one with this link. You will need a code sent to the new number.\n\nAttach a new number: ',
    ),
    recover.text,
  );
  assert.deepEqual(
    inside(recover.html, 'tm-muted" style="margin:0;font-size:14px'),
    [
      'The link works for 30 minutes. If you didn’t ask for this, ignore this email: nothing changes.',
    ],
  );
  assert.ok(
    recover.text.includes(
      'You get this email because someone asked to recover the TipMe account at this address.',
    ),
  );
});

/**
 * Every type's sample as the release before the board emails (M2) had it, verbatim. Mail queued
 * before a deploy carries data like this and is rendered by the new templates.
 */
const PREVIOUS_SAMPLES = {
  tip_received: {
    firstName: 'Ada',
    netMinor: '450000',
    supporterLabel: 'Tobi',
    pretendPayment: false,
  },
  weekly_report: { isoWeek: '2026-W43', totalNetMinor: '1250000', tipCount: 4 },
  email_verification_link: {
    token: 'sample-token-sample-token-sample-token-0001',
  },
  recovery_link: { token: 'sample-token-sample-token-sample-token-0002' },
  staff_invitation: { code: 'SAMPLEC2DE', kind: 'invited' },
  staff_invitation_declined: {
    personHint: 'a•••@example.com',
    roleName: 'Support',
  },
  staff_acted_alone: {
    personHint: 'a•••@example.com',
    action: 'Change a page’s fee',
  },
  staff_freeze_released: { personHint: 'a•••@example.com', stillHeld: false },
  staff_approval_outcome: {
    action: 'Change a page’s fee',
    outcome: 'approved',
  },
  staff_approval_pending: {
    personHint: 'a•••@example.com',
    action: 'Change a page’s fee',
  },
  staff_last_approver_removed: {
    personHint: 'a•••@example.com',
    permissions: 'fees.manage,staff.manage',
  },
  phone_change_warning: { newPhoneHint: '•••4821' },
  provider_test: {
    providerLabel: 'ZeptoMail',
    token: 'sample-token-sample-token-sample-token-0003',
  },
  sign_in_code: { code: '482915' },
  email_change_code: { code: '482915' },
  payout_destination_code: { code: '482915' },
  payout_destination_changed: {
    bankName: 'Guaranty Trust Bank',
    last4: '1234',
    previousBankName: 'Providus Bank',
    previousLast4: '6789',
  },
  welcome: {},
  new_sign_in_notice: { deviceLabel: 'Safari on iPhone' },
  email_changed_notice: { newEmailHint: 'a•••@example.com' },
  recovery_email_code: { code: '482915' },
  recovery_change_code: { code: '482915' },
  recovery_code: { code: '482915' },
  recovery_new_email_code: { code: '482915' },
  recovery_started_notice: { newEmailHint: 'a•••@example.com' },
  recovery_cancelled_notice: { newEmailHint: 'a•••@example.com' },
  recovery_completed_notice: { newEmailHint: 'a•••@example.com' },
  staff_access_notice: { change: 'granted' },
  account_deleted_notice: {},
  payment_account_ready: {},
  payment_account_action_needed: {},
  page_paused: {},
  page_image_removed: { image: 'cover' },
  page_restored: {},
  withdrawal_paid: { amountMinor: '250000' },
  withdrawal_failed: { amountMinor: '250000' },
  tip_reversed: {},
  milestone: { copy: '10 tips! People keep coming back to thank you.' },
};

const settingsCtx = {
  ...ctx,
  unsubscribeUrl: 'https://usetipme.xyz/email-settings?u=abc&s=def',
};

test('last release’s samples still render', () => {
  assert.deepEqual(
    Object.keys(PREVIOUS_SAMPLES).sort(),
    Object.keys(MAIL_TYPES).sort(),
    'one previous sample per type',
  );
  for (const [id, data] of Object.entries(PREVIOUS_SAMPLES)) {
    const out = renderMail(id, data, settingsCtx);
    for (const part of [out.subject, out.text, visible(out.html)]) {
      assert.doesNotMatch(part, /undefined|null|NaN|\[object/, id);
    }
    // No label left without its value, and no empty panel.
    assert.doesNotMatch(out.text, /^[A-Z][a-z ]+:\s*$/m, `${id} empty row`);
    assert.doesNotMatch(
      out.html,
      /class="tm-well"[^>]*>\s*<\/td>/,
      `${id} well`,
    );
    assert.doesNotMatch(out.html, /border="0"><\/table>/, `${id} empty facts`);
    for (const [, href] of out.html.matchAll(/href="([^"]*)"/g))
      assert.match(
        href,
        /^(https:\/\/usetipme\.xyz\/|mailto:)/,
        `${id} ${href}`,
      );
  }
});

const tip = (extra = {}) =>
  renderMail(
    'tip_received',
    {
      firstName: 'Ada',
      netMinor: '405050',
      supporterLabel: 'Chidi',
      pretendPayment: false,
      ...extra,
    },
    settingsCtx,
  );

test('the tip email puts the amount on the slab, exact to the kobo', () => {
  const out = tip();
  assert.equal(out.subject, 'You got a ₦4,050.50 tip on TipMe');
  assert.match(out.html, /class="tm-slab"/);
  assert.match(out.html, /class="tm-amount"[^>]*>₦4,050\.50</);
  assert.ok(
    out.text.startsWith(
      'Ada, you got a tip.\n\n₦4,050.50\nFrom Chidi. Confirmed by our payment partner.\n\nSee your tips: https://usetipme.xyz/dashboard/tips?ml=see_tips\n\nIt is in your balance now.\n',
    ),
    out.text,
  );
  assert.doesNotMatch(out.text, /left you a note|payment provider/);
  const guest = tip({ supporterLabel: null });
  assert.ok(
    guest.text.includes('From a guest. Confirmed by our payment partner.'),
  );
  // The preview line names nobody.
  for (const out of [tip(), guest, tip({ hasNote: true })]) {
    assert.equal(
      preheaderOf(out.html),
      'Confirmed by our payment partner. It is in your balance now.',
    );
  }
  assert.ok(
    tip({ pretendPayment: true }).text.includes(
      'Pretend payment: no real money moved.',
    ),
  );
});

test('a tip with a note says so, and never carries its words', () => {
  const out = tip({ hasNote: true });
  assert.ok(out.text.includes('Chidi left you a note.'), out.text);
  assert.ok(
    out.text.includes(
      'Read it on TipMe: https://usetipme.xyz/dashboard/tips?ml=see_tips',
    ),
  );
  assert.doesNotMatch(out.text, /See your tips/);
  assert.ok(
    tip({ hasNote: true, supporterLabel: null }).text.includes(
      'Your supporter left you a note.',
    ),
  );
  assert.ok(visible(out.html).includes('Chidi left you a note.'));
});

test('no mail schema accepts a note', () => {
  for (const [id, type] of Object.entries(MAIL_TYPES)) {
    for (const key of ['message', 'note', 'body', 'noteText'])
      assert.equal(
        type.schema.safeParse({ ...type.sample, [key]: 'x' }).success,
        false,
        `${id} takes ${key}`,
      );
    for (const key of Object.keys(type.schema.shape ?? {}))
      if (key !== 'hasNote')
        assert.doesNotMatch(key, /message|note|body/i, `${id}.${key}`);
  }
});

test('the withdraw line uses the amount it is given', () => {
  const out = tip({ minWithdrawalMinor: '300000' });
  assert.ok(
    out.text.includes(
      'It is in your balance now. You can withdraw from ₦3,000.',
    ),
    out.text,
  );
  assert.doesNotMatch(tip().text, /withdraw from/);
});

test('the new sign-in email shows the device and the Lagos time', () => {
  const out = renderMail(
    'new_sign_in_notice',
    {
      deviceLabel: 'Chrome on an Android phone',
      at: '2026-11-05T13:32:00.000Z',
    },
    ctx,
  );
  assert.ok(
    out.text.startsWith(
      'Your account’s safety\n\nA new device signed in\n\nYour TipMe account was just signed in to from a device we haven’t seen before.\n\nDevice: Chrome on an Android phone\nWhen: 5 Nov 2026, 14:32\n\nIf this was you, there’s nothing to do.\n\nWasn’t you? Sign in and end that session in Settings.\n\nCheck your sign-ins: https://usetipme.xyz/dashboard/settings?ml=sessions#security',
    ),
    out.text,
  );
  assert.equal(
    preheaderOf(out.html),
    'If this was you, there’s nothing to do.',
  );
  // September is "Sep", whatever the runtime's locale data says; midnight is 00.
  assert.ok(
    renderMail(
      'new_sign_in_notice',
      { deviceLabel: '', at: '2026-09-05T23:05:00.000Z' },
      ctx,
    ).text.includes('\n\nWhen: 6 Sep 2026, 00:05\n\n'),
  );
  // Neither row known: no empty panel.
  const bare = renderMail('new_sign_in_notice', { deviceLabel: '' }, ctx);
  assert.doesNotMatch(bare.text, /Device:|When:/);
  assert.doesNotMatch(bare.html, /class="tm-well"/);
});

test('the ready email shows the page link when it has the handle, and still reads without it', () => {
  const out = renderMail('payment_account_ready', { handle: 'ada' }, ctx);
  assert.ok(
    out.text.startsWith(
      'You can receive tips now\n\nYour payment account is ready, so people can tip you. Share your link to get your first one.\n\nusetipme.xyz/@ada\nPut it in your bio, or print your QR code.\nhttps://usetipme.xyz/@ada\n\nGo to your dashboard: ',
    ),
    out.text,
  );
  assert.match(
    out.html,
    /<a href="https:\/\/usetipme\.xyz\/@ada"[^>]*>usetipme\.xyz\/@ada</,
  );
  assert.ok(
    out.text.includes(
      'You get this email when your TipMe page is ready to take tips.',
    ),
  );
  assert.doesNotMatch(out.text, /bank account/);
  const without = renderMail('payment_account_ready', {}, ctx);
  assert.doesNotMatch(without.text, /xyz\/@|Put it in your bio/);
  assert.ok(without.text.includes('Go to your dashboard: '));
});

test('the bank change email strikes through the old account', () => {
  const out = renderMail(
    'payout_destination_changed',
    MAIL_TYPES.payout_destination_changed.sample,
    ctx,
  );
  assert.equal(out.subject, 'Your TipMe bank account changed');
  assert.ok(
    out.text.startsWith(
      'Your account’s safety\n\nYour bank account changed\n\nYour next withdrawal goes to the new account. One already under way still goes to the account it started with.\n\nNow: Guaranty Trust Bank ••1234\nBefore: Providus Bank ••6789\n\nWasn’t you? Contact support@usetipme.xyz straight away. We can stop withdrawals while we look.\n\n—\nYou get this email whenever the bank account on your TipMe page changes.',
    ),
    out.text,
  );
  assert.match(out.html, /line-through[^>]*>Providus Bank ••6789</);
  assert.doesNotMatch(out.html, /line-through[^>]*>Guaranty/);
  assert.doesNotMatch(preheaderOf(out.html), /Bank|\d{4}/);
});

test('the number change and deleted account emails read as the board', () => {
  const phone = renderMail(
    'phone_change_warning',
    { newPhoneHint: '•••47' },
    ctx,
  );
  assert.ok(
    phone.text.startsWith(
      'Your account’s safety\n\nYour number changes in 24 hours\n\nSomeone asked to move your TipMe account to a new number ending •••47.\n\nWasn’t you? Sign in and cancel it in Settings before it happens.\n\nSign in to cancel: https://usetipme.xyz/dashboard/settings?ml=',
    ),
    phone.text,
  );
  assert.ok(
    phone.text.includes(
      'You get this email because a number change was requested on your TipMe account.',
    ),
  );
  const gone = renderMail('account_deleted_notice', {}, ctx);
  assert.ok(
    gone.text.startsWith(
      'Your account was deleted\n\nYour TipMe account and page are gone. This is the last email we’ll send you.\n\nDidn’t do this? Reply to this email straight away.\n\n—',
    ),
    gone.text,
  );
});

const week = (isoWeek, totalNetMinor = '1250000', tipCount = 4) =>
  renderMail(
    'weekly_report',
    { isoWeek, totalNetMinor, tipCount },
    settingsCtx,
  );

test('the weekly report names the week’s days, across a year end too', () => {
  // Checked against isoWeekOf in packages/database/src/operations/reports.ts: Lagos
  // 2025-10-27 is 2025-W44; 2026-10-19 is 2026-W43; 2026-12-28 and 2027-01-03 are 2026-W53;
  // 2027-01-04 is 2027-W01.
  for (const [isoWeek, days] of [
    ['2025-W44', '27 October to 2 November.'],
    ['2026-W43', '19 October to 25 October.'],
    ['2026-W53', '28 December to 3 January.'],
    ['2027-W01', '4 January to 10 January.'],
  ]) {
    const out = week(isoWeek);
    assert.ok(
      out.text.startsWith(`Your week on TipMe\n\n${days}\n\n`),
      `${isoWeek}: ${out.text}`,
    );
  }
  const out = week('2026-W43');
  assert.ok(
    out.text.includes(
      '₦12,500 you received\n4 tips\n\nSee the whole week: https://usetipme.xyz/dashboard/reports?ml=open_report',
    ),
    out.text,
  );
  assert.ok(
    out.text.includes(
      'You get this email every Monday when you were tipped last week.\nEmail settings: ',
    ),
  );
  assert.match(out.html, /class="tm-well tm-stat"/);
  assert.equal(preheaderOf(out.html), 'See the whole week.');
});

test('the weekly report counts one tip in the singular', () => {
  assert.ok(
    week('2026-W43', '180000', 1).text.includes('₦1,800 you received\n1 tip\n'),
  );
});

test('the invitation never prints its code', () => {
  const out = renderMail(
    'staff_invitation',
    MAIL_TYPES.staff_invitation.sample,
    ctx,
  );
  assert.equal(out.subject, 'You’re invited to TipMe’s admin area');
  const code = MAIL_TYPES.staff_invitation.sample.code;
  assert.ok(!visible(out.html).includes(code), 'not shown');
  assert.ok(!preheaderOf(out.html).includes(code));
  // Only inside the one-time link.
  assert.equal(out.html.split(code).length - 1, 1);
  assert.equal(out.text.split(code).length - 1, 1);
  assert.match(
    out.text,
    new RegExp(
      `Set up your authenticator: https://usetipme.xyz/ops\\?ml=staff_enrol#enrol=${code}`,
    ),
  );
  assert.ok(
    out.text.startsWith(
      'You’re invited to TipMe’s admin area\n\nSign in with this email address, then set up an authenticator app to finish. The link works once, for 30 minutes.\n\nSet up your authenticator: ',
    ),
    out.text,
  );
  assert.deepEqual(
    inside(out.html, 'tm-muted" style="margin:0;font-size:14px'),
    [
      'Don’t want this? Open the link, sign in, and choose Decline. If you weren’t expecting it at all, tell the person who runs your TipMe admin area.',
    ],
  );
  // The reset keeps its words.
  const reset = renderMail('staff_invitation', { code, kind: 'reset' }, ctx);
  assert.equal(reset.subject, 'Set up your TipMe admin authenticator again');
  assert.ok(
    reset.text.includes(
      'Your authenticator was reset, so your admin access is paused until you set up a new one. This link works once, for 30 minutes.',
    ),
  );
  assert.ok(!visible(reset.html).includes(code));
});

test('every security email from the boards carries the safety line', () => {
  for (const id of [
    'payout_destination_changed',
    'new_sign_in_notice',
    'phone_change_warning',
  ]) {
    const out = renderMail(id, MAIL_TYPES[id].sample, ctx);
    assert.ok(out.text.startsWith('Your account’s safety\n\n'), id);
    assert.match(out.html, /class="tm-tag"/, id);
  }
  // Mail about money and pages is not a safety notice.
  for (const id of ['tip_received', 'weekly_report', 'payment_account_ready'])
    assert.doesNotMatch(
      renderMail(id, MAIL_TYPES[id].sample, ctx).html,
      /class="tm-tag"/,
      id,
    );
});
