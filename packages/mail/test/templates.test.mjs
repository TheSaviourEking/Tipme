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
