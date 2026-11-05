import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MAIL_TYPES,
  mailLink,
  renderMail,
  MAIL_SENDERS,
  senderAddress,
} from '../dist/index.js';

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

const TAKE_BACK_TYPES = [
  'username_take_back_notice',
  'username_take_back_reminder',
  'username_take_back_done',
  'username_take_back_cancelled',
];
const WHY = 'The username infringes a trademark.';
const doneData = (variant, extra = {}) => ({
  variant,
  old: 'kemi',
  new:
    variant === 'user_chose' ||
    variant === 'assigned' ||
    variant === 'without_notice' ||
    variant === 'unreached'
      ? 'kemi_new'
      : null,
  current: 'kemi_now',
  why: WHY,
  noticeDate: variant === 'assigned' ? '3 November 2026' : null,
  freeChangeDate:
    variant === 'assigned' ||
    variant === 'without_notice' ||
    variant === 'unreached'
      ? '10 December 2026'
      : null,
  ...extra,
});

test('each take-back type renders its sample and every variant', () => {
  for (const id of TAKE_BACK_TYPES) {
    const out = renderMail(id, MAIL_TYPES[id].sample, ctx);
    assert.ok(out.subject && out.text, id);
  }
  const current = renderMail(
    'username_take_back_notice',
    {
      kind: 'current',
      old: 'kemi',
      current: 'kemi',
      why: WHY,
      dueDate: '10 November 2026',
    },
    ctx,
  );
  assert.equal(current.subject, 'We need your TipMe username back');
  for (const words of [
    `TipMe needs the username @kemi back. ${WHY}`,
    'Please choose a new username by the end of 10 November 2026. You can do it in Settings, and it won’t use up any of your username changes.',
    'Your page, your tips and your balance stay yours under the new username. Links and QR codes that use @kemi will stop working, so update them once you have chosen.',
    'If you haven’t chosen by then, we will give your page a new username and email it to you.',
    'Reply to this email if you have a question.',
    'Choose a new username: https://usetipme.xyz/dashboard/settings?ml=choose_username#handle',
  ])
    assert.ok(current.text.includes(words), words);
  const old = renderMail(
    'username_take_back_notice',
    {
      kind: 'old',
      old: 'kemi_old',
      current: 'kemi',
      why: WHY,
      dueDate: '10 November 2026',
    },
    ctx,
  );
  assert.equal(old.subject, 'A link to your TipMe page will stop working');
  assert.ok(
    old.text.includes(
      `Your page keeps its username @kemi. Links and QR codes that still use your old username @kemi_old will stop working after 10 November 2026. ${WHY} Share your current link and print a new QR code if you need one.`,
    ),
  );
  const reminder = renderMail(
    'username_take_back_reminder',
    { old: 'kemi', dueDate: '10 November 2026' },
    ctx,
  );
  assert.equal(reminder.subject, '2 days left to choose a new TipMe username');
  assert.ok(
    reminder.text.includes(
      'This is a reminder that TipMe needs the username @kemi back. Please choose a new username in Settings by the end of 10 November 2026. If you don’t, we will give your page one and email it to you. Your page, tips and balance stay yours.',
    ),
  );
  const done = (variant) =>
    renderMail('username_take_back_done', doneData(variant), ctx);
  assert.equal(done('assigned').subject, 'Your TipMe page has a new username');
  assert.ok(
    done('assigned').text.includes(
      'As we said on 3 November 2026, TipMe has taken back @kemi. Your page is now at https://usetipme.xyz/@kemi_new. Your tips and balance haven’t changed. Links and QR codes with @kemi no longer work, so share your new link and print a new QR code. You can change your new username once, for free, in Settings until 10 December 2026.',
    ),
  );
  assert.equal(done('user_chose').subject, 'Your new TipMe username is ready');
  assert.ok(
    done('user_chose').text.includes(
      'Your page is now at https://usetipme.xyz/@kemi_new. The username @kemi is no longer yours, and links with it no longer work.',
    ),
  );
  assert.equal(
    done('old').subject,
    'An old link to your TipMe page has stopped working',
  );
  assert.ok(
    done('old').text.includes(
      'Links and QR codes with @kemi no longer lead to your page. Your page is still at https://usetipme.xyz/@kemi_now.',
    ),
  );
  assert.equal(
    done('without_notice').subject,
    'We changed your TipMe username',
  );
  assert.ok(
    done('without_notice').text.includes(
      `We have changed your page’s username from @kemi to @kemi_new, without notice, as our terms allow in this case. ${WHY} Your page, your tips and your balance are unchanged. Links and QR codes with @kemi no longer work. You can change your new username once, for free, in Settings until 10 December 2026. Reply to this email if you think this is a mistake.`,
    ),
  );
  assert.equal(done('unreached').subject, 'Your TipMe page has a new username');
  assert.ok(
    done('unreached').text.includes(
      `We couldn’t reach you about the username @kemi, so, as our terms say, TipMe has taken it back. ${WHY} Your page is now at https://usetipme.xyz/@kemi_new. Your tips and balance haven’t changed. Links and QR codes with @kemi no longer work, so share your new link and print a new QR code. You can change your new username once, for free, in Settings until 10 December 2026.`,
    ),
  );
  const cancelled = renderMail(
    'username_take_back_cancelled',
    { old: 'kemi' },
    ctx,
  );
  assert.equal(cancelled.subject, 'You can keep your TipMe username');
  assert.ok(
    cancelled.text.includes(
      'We no longer need the username @kemi. It stays yours, and your links and QR codes keep working. You don’t need to do anything.',
    ),
  );
  // A variant missing what it says is refused rather than rendered with a gap.
  assert.throws(() =>
    renderMail(
      'username_take_back_done',
      doneData('assigned', { new: null }),
      ctx,
    ),
  );
});

test('no take-back subject or body has an em dash, and subjects are sentence case', () => {
  const samples = [
    ...TAKE_BACK_TYPES.map((id) => [id, MAIL_TYPES[id].sample]),
    ...['assigned', 'user_chose', 'old', 'without_notice', 'unreached'].map(
      (v) => ['username_take_back_done', doneData(v)],
    ),
  ];
  for (const [id, data] of samples) {
    const out = renderMail(id, data, ctx);
    // The shared layout's plain-text footer rule is a lone dash line; the copy itself has none.
    const copy = out.text
      .split('\n')
      .filter((line) => line.trim() !== '\u2014')
      .join('\n');
    assert.equal(/[\u2013\u2014]/.test(out.subject + copy), false, id);
    const rest = out.subject.slice(1).replace(/TipMe/g, '');
    assert.equal(
      rest,
      rest.toLowerCase().replace(/tipme/g, ''),
      `${id}: ${out.subject}`,
    );
    assert.ok(
      out.text.includes(
        'You get this email when TipMe needs a username back. It can’t be turned off.',
      ),
      id,
    );
  }
});

test('the notice carries the fixed why only', () => {
  const schema = MAIL_TYPES.username_take_back_notice.schema;
  const data = {
    kind: 'current',
    old: 'kemi',
    current: 'kemi',
    why: WHY,
    dueDate: '10 November 2026',
  };
  assert.ok(schema.safeParse(data).success);
  // No field for staff words, and the why is one of the fixed sentences.
  assert.equal(
    schema.safeParse({ ...data, message: 'Hello from staff' }).success,
    false,
  );
  assert.equal(
    schema.safeParse({ ...data, why: 'Because a staff member said so.' })
      .success,
    false,
  );
  assert.equal(
    MAIL_TYPES.username_take_back_done.schema.safeParse({
      ...doneData('assigned'),
      why: 'Staff text.',
    }).success,
    false,
  );
});

test('take-back emails cannot be turned off', () => {
  for (const id of TAKE_BACK_TYPES) {
    assert.equal(MAIL_TYPES[id].preference, null, id);
    assert.equal(MAIL_TYPES[id].category, 'account', id);
    assert.equal(MAIL_TYPES[id].sender, 'notifications', id);
  }
});
