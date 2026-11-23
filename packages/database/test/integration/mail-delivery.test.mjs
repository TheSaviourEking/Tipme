import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createBrevoProvider,
  createMockMailProvider,
  MAIL_TYPES,
  MailQuotaError,
  MailRejectedError,
  MailTemporaryError,
  senderAddress,
} from '@tipme/mail';
import {
  addressHmac,
  claimDueMail,
  deliverDueMail,
  enqueueMail,
  listPretendOutbox,
  MAIL_BACKOFF_MS,
  MAIL_QUOTA_RETRY_MS,
  mailSealing,
  requeueStuckMail,
  wipeExpiredMailContent,
  writePretendMessage,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// The worker sends queued mail outside any transaction: security mail first, retried on a
// schedule, never after a code has expired, never to a suppressed address, and never when the
// person turned that email off after it was queued.

const sealing = mailSealing(Buffer.alloc(32, 7));
const WEB = 'http://localhost:3000';
const TOBI_USER = '00000000-0000-7000-8000-000000007b11';
const tip = {
  firstName: 'Tobi',
  netMinor: '180000',
  supporterLabel: 'Ada',
  pretendPayment: true,
};
const verify = { token: 'sample-token-sample-token-sample-token-0001' };

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

/** A provider whose next sends do what the test says. */
function scripted(outcomes) {
  const sent = [];
  return {
    sent,
    provider: {
      name: 'zeptomail',
      capabilities: { marketing: false },
      async send(mail) {
        const next = outcomes.shift() ?? { ok: true };
        if (next.permanent) throw new MailRejectedError(next.permanent);
        if (next.temporary) throw new MailTemporaryError(next.temporary);
        sent.push(mail);
        return { providerMessageId: `z-${sent.length}` };
      },
      verifyWebhook: () => ({ ok: false, reason: 'signature' }),
      async status() {
        return { sandbox: null, detail: null };
      },
    },
  };
}

function deps(db, provider, name = provider.name) {
  return {
    db,
    sealing,
    providers: new Map([[name, provider]]),
    activeProvider: async () => name,
    overrideFor: async () => null,
    sender: { domain: 'mail.usetipme.xyz', name: 'TipMe' },
    replyTo: 'support@usetipme.xyz',
    webOrigin: WEB,
    apiOrigin: 'http://localhost:4000',
  };
}

const mockProvider = (db) =>
  createMockMailProvider(async (mail) =>
    writePretendMessage(db, {
      channel: 'email',
      recipientHint: 'pretend',
      subject: mail.subject,
      body: mail.text,
    }),
  );

test('queued mail is sent and recorded', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.sent',
  });
  const result = await deliverDueMail(deps(db, mockProvider(db)), {
    now: new Date(),
    limit: 20,
  });
  assert.equal(result.sent, 1);
  const [row] = await rows(
    'SELECT status, provider, provider_message_id, sent_at IS NOT NULL AS sent FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.deepEqual(row, {
    status: 'sent',
    provider: 'mock',
    provider_message_id: `mock-${id}`,
    sent: true,
  });
  const events = await rows(
    'SELECT kind FROM mail_message_events WHERE message_id = $1 ORDER BY occurred_at, kind',
    [id],
  );
  assert.deepEqual(
    events.map((e) => e.kind),
    ['queued', 'sent'],
  );
  const [inbox] = await listPretendOutbox(db, { limit: 1 });
  assert.equal(inbox.subject, 'You got a ₦1,800 tip on TipMe');
});

test('security mail is claimed before older engagement mail', async (t) => {
  const { db } = await fresh(t);
  const earlier = new Date(Date.now() - 60_000);
  for (let i = 0; i < 50; i++)
    await enqueueMail(db, sealing, {
      type: 'weekly_report',
      to: `p${i}@example.com`,
      data: { isoWeek: '2026-W43', totalNetMinor: '100', tipCount: 1 },
      dedupeKey: `weekly_report.${i}`,
      now: earlier,
    });
  await enqueueMail(db, sealing, {
    type: 'email_verification_link',
    to: 'tobi@example.com',
    data: verify,
    dedupeKey: 'email_verification_link.first',
  });
  const [first] = await claimDueMail(db, sealing, {
    now: new Date(),
    limit: 1,
  });
  assert.equal(first.type, 'email_verification_link');
  assert.equal(first.to, 'tobi@example.com');
});

// Seen in e2e: 3,000+ staff alerts queued ahead of 190 sign-in codes. Both are security mail, so
// the codes waited their turn behind every older alert.
test('a sign-in code goes out before a burst of older staff alerts', async (t) => {
  const { db, rows } = await fresh(t);
  const earlier = new Date(Date.now() - 60_000);
  for (let i = 0; i < 200; i++)
    await enqueueMail(db, sealing, {
      type: 'staff_approval_pending',
      to: `owner${i}@example.com`,
      data: MAIL_TYPES.staff_approval_pending.sample,
      dedupeKey: `staff_approval_pending.${i}`,
      now: earlier,
    });
  const { id } = await enqueueMail(db, sealing, {
    type: 'sign_in_code',
    to: 'ada@example.com',
    data: { code: '482915' },
    dedupeKey: 'sign_in_code.waiting',
  });
  // One pass of the worker (20 at a time, as it runs): the code is in it.
  const sent = [];
  const provider = createMockMailProvider(async (mail) => {
    sent.push(mail.subject);
    return writePretendMessage(db, {
      channel: 'email',
      recipientHint: 'pretend',
      subject: mail.subject,
      body: mail.text,
    });
  });
  await deliverDueMail(deps(db, provider), { now: new Date(), limit: 20 });
  assert.equal(sent[0], 'Your TipMe sign-in code');
  const [code] = await rows(`SELECT status FROM mail_messages WHERE id = $1`, [
    id,
  ]);
  assert.equal(code.status, 'sent');
  assert.equal(
    (
      await rows(
        `SELECT count(*)::int AS n FROM mail_messages WHERE type = 'staff_approval_pending' AND status = 'queued'`,
      )
    )[0].n,
    181,
  );
});

test('mail someone is waiting for on screen outranks other security mail', async (t) => {
  const { db, rows } = await fresh(t);
  const waiting = [
    'sign_in_code',
    'email_change_code',
    'payout_destination_code',
    'recovery_change_code',
    'recovery_code',
    'recovery_email_code',
    'recovery_new_email_code',
    'email_verification_link',
    'recovery_link',
  ];
  const others = {
    staff_approval_pending: 1,
    staff_invitation: 1,
    new_sign_in_notice: 1,
    welcome: 2,
    tip_received: 3,
    weekly_report: 3,
    // Announcements (#213, bulk): after everything else, beside #206's 0 to 3 (merge train 2).
    announcement: 9,
    service_notice: 9,
  };
  for (const type of [...waiting, ...Object.keys(others)])
    await enqueueMail(db, sealing, {
      type,
      to: 'ada@example.com',
      data: MAIL_TYPES[type].sample,
      dedupeKey: `${type}.rank`,
    });
  const ranks = Object.fromEntries(
    (await rows(`SELECT type, priority FROM mail_messages`)).map((row) => [
      row.type,
      row.priority,
    ]),
  );
  assert.deepEqual(ranks, {
    ...Object.fromEntries(waiting.map((type) => [type, 0])),
    ...others,
  });
});

test('a temporary failure is retried on the backoff schedule', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.retry',
  });
  const now = new Date();
  const { provider } = scripted([{ temporary: 'busy' }]);
  await deliverDueMail(deps(db, provider), { now, limit: 20 });
  const [row] = await rows(
    'SELECT status, attempts, next_attempt_at, last_error FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.equal(row.status, 'queued');
  assert.equal(row.attempts, 1);
  assert.equal(row.last_error, 'busy');
  assert.equal(
    row.next_attempt_at.getTime(),
    now.getTime() + MAIL_BACKOFF_MS[0],
  );
});

test('the sixth temporary failure fails the mail', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.six',
  });
  const { provider } = scripted(
    Array.from({ length: 6 }, () => ({ temporary: 'busy' })),
  );
  let now = new Date();
  for (let i = 0; i < 6; i++) {
    await deliverDueMail(deps(db, provider), { now, limit: 20 });
    now = new Date(now.getTime() + 7 * 3_600_000);
  }
  const [row] = await rows(
    'SELECT status, attempts FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.deepEqual(row, { status: 'failed', attempts: 6 });
});

test('a permanent rejection fails at once', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.permanent',
  });
  const { provider } = scripted([{ permanent: 'SM_111' }]);
  await deliverDueMail(deps(db, provider), { now: new Date(), limit: 20 });
  const [row] = await rows(
    'SELECT status, attempts, last_error, final_at IS NOT NULL AS final FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.deepEqual(row, {
    status: 'failed',
    attempts: 1,
    last_error: 'SM_111',
    final: true,
  });
});

test('a code that outlives a provider outage expires instead of arriving late', async (t) => {
  const { db, rows } = await fresh(t);
  const start = new Date();
  const { id } = await enqueueMail(db, sealing, {
    type: 'email_verification_link',
    to: 'tobi@example.com',
    data: verify,
    dedupeKey: 'email_verification_link.outage',
    expiresAt: new Date(start.getTime() + 10 * 60_000),
    now: start,
  });
  const { provider, sent } = scripted([
    { temporary: 'down' },
    { temporary: 'down' },
    { temporary: 'down' },
    { ok: true },
  ]);
  let now = start;
  for (let i = 0; i < 4; i++) {
    await deliverDueMail(deps(db, provider), { now, limit: 20 });
    now = new Date(now.getTime() + 11 * 60_000);
  }
  const [row] = await rows('SELECT status FROM mail_messages WHERE id = $1', [
    id,
  ]);
  assert.equal(row.status, 'expired');
  assert.equal(sent.length, 0);
});

test('suppressed addresses are not sent to', async (t) => {
  const { db, rows } = await fresh(t);
  await db.execute(
    `INSERT INTO mail_suppressions (address_hmac, reason) VALUES ('${addressHmac(sealing, 'Tobi@Example.com')}', 'hard_bounce')`,
  );
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.suppressed',
  });
  const { provider, sent } = scripted([]);
  await deliverDueMail(deps(db, provider), { now: new Date(), limit: 20 });
  const [row] = await rows('SELECT status FROM mail_messages WHERE id = $1', [
    id,
  ]);
  assert.equal(row.status, 'suppressed');
  assert.equal(sent.length, 0);
});

test('a preference turned off after queueing is respected', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    userId: TOBI_USER,
    data: tip,
    dedupeKey: 'tip_received.preference',
  });
  await db.execute(
    `UPDATE profiles SET notify_tip_emails = false WHERE user_id = '${TOBI_USER}'`,
  );
  const { provider, sent } = scripted([]);
  await deliverDueMail(deps(db, provider), { now: new Date(), limit: 20 });
  const [row] = await rows('SELECT status FROM mail_messages WHERE id = $1', [
    id,
  ]);
  assert.equal(row.status, 'skipped');
  assert.equal(sent.length, 0);
});

test('mail stuck in sending is requeued after two minutes', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.stuck',
  });
  const claimedAt = new Date();
  await claimDueMail(db, sealing, { now: claimedAt, limit: 1 });
  assert.equal(
    await requeueStuckMail(db, new Date(claimedAt.getTime() + 60_000)),
    0,
  );
  assert.equal(
    await requeueStuckMail(db, new Date(claimedAt.getTime() + 121_000)),
    1,
  );
  const [row] = await rows('SELECT status FROM mail_messages WHERE id = $1', [
    id,
  ]);
  assert.equal(row.status, 'queued');
});

test('sealed content is wiped seven days after the final status, metadata kept', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.wipe',
  });
  const now = new Date();
  await deliverDueMail(deps(db, mockProvider(db)), { now, limit: 20 });
  assert.equal(
    await wipeExpiredMailContent(db, new Date(now.getTime() + 6 * 86_400_000)),
    0,
  );
  assert.equal(
    await wipeExpiredMailContent(db, new Date(now.getTime() + 8 * 86_400_000)),
    1,
  );
  const [row] = await rows(
    'SELECT to_sealed, data_sealed, rendered_sealed IS NOT NULL AS snapshot, to_hint, type, status FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.deepEqual(row, {
    to_sealed: null,
    data_sealed: null,
    snapshot: true,
    to_hint: 't•••@example.com',
    type: 'tip_received',
    status: 'sent',
  });
});

test('security mail is sent without tracking and with no snapshot', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'email_verification_link',
    to: 'tobi@example.com',
    data: verify,
    dedupeKey: 'email_verification_link.untracked',
  });
  const { provider, sent } = scripted([]);
  await deliverDueMail(deps(db, provider), { now: new Date(), limit: 20 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].tracking, false);
  assert.equal(sent[0].reference, id);
  assert.equal(sent[0].replyTo, 'support@usetipme.xyz');
  const [row] = await rows(
    'SELECT rendered_sealed FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.equal(row.rendered_sealed, null);
});

// Review fixes (PR #45).

test('a mail the provider accepted is never sent again when what follows the send fails', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.log-throws',
  });
  const { provider, sent } = scripted([]);
  const failingLog = {
    ...deps(db, provider),
    log() {
      throw new Error('log sink down');
    },
  };
  await deliverDueMail(failingLog, { now: new Date(), limit: 20 }).catch(
    () => undefined,
  );
  const [row] = await rows('SELECT status FROM mail_messages WHERE id = $1', [
    id,
  ]);
  assert.equal(row.status, 'sent');
  assert.equal(sent.length, 1);
});

test('a worker whose claim was taken over cannot overwrite the new outcome', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.stale-claim',
  });
  const start = new Date();
  // Worker A claims, then stalls past the two-minute limit.
  const [stale] = await claimDueMail(db, sealing, { now: start, limit: 1 });
  const later = new Date(start.getTime() + 3 * 60_000);
  assert.equal(await requeueStuckMail(db, later), 1);
  // Worker B claims and sends it.
  await deliverDueMail(deps(db, mockProvider(db)), { now: later, limit: 20 });
  // A finally reports a temporary failure for its old claim: nothing changes.
  const { recordMailFailure } = await import('../../dist/index.js');
  assert.equal(
    await recordMailFailure(db, {
      ...stale,
      provider: 'zeptomail',
      code: 'late',
      permanent: false,
      now: new Date(later.getTime() + 1000),
    }),
    'stale',
  );
  const [row] = await rows(
    'SELECT status, attempts FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.deepEqual(row, { status: 'sent', attempts: 1 });
});

test('one unreadable mail fails on its own and does not hold back the rest', async (t) => {
  const { db, rows } = await fresh(t);
  const broken = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.broken',
  });
  const code = await enqueueMail(db, sealing, {
    type: 'email_verification_link',
    to: 'ada@example.com',
    data: verify,
    dedupeKey: 'email_verification_link.after-broken',
  });
  await db.execute(
    `UPDATE mail_messages SET data_sealed = 'v1.AAAA.AAAA.AAAA', priority = 0 WHERE id = '${broken.id}'`,
  );
  const { provider, sent } = scripted([]);
  await deliverDueMail(deps(db, provider), { now: new Date(), limit: 20 });
  const status = async (id) =>
    (
      await rows('SELECT status, last_error FROM mail_messages WHERE id = $1', [
        id,
      ])
    )[0];
  assert.deepEqual(await status(broken.id), {
    status: 'failed',
    last_error: 'unreadable',
  });
  assert.equal((await status(code.id)).status, 'sent');
  assert.equal(sent.length, 1);
});

test('mail to an address that can never receive it goes to the pretend inbox, not the active provider', async (t) => {
  const { db } = await fresh(t);
  const real = scripted([]);
  const pretend = scripted([]);
  const both = {
    ...deps(db, real.provider),
    providers: new Map([
      ['zeptomail', real.provider],
      ['mock', pretend.provider],
    ]),
    activeProvider: async () => 'zeptomail',
    pretendDomains: ['release-check.usetipme.xyz'],
  };
  for (const [to, key] of [
    ['r@rc-1a2b.example', 'a'],
    ['release@release-check.usetipme.xyz', 'b'],
    ['tobi@realmail.com', 'c'],
  ])
    await enqueueMail(db, sealing, {
      type: 'tip_received',
      to,
      data: tip,
      dedupeKey: `tip_received.pretend.${key}`,
    });
  await deliverDueMail(both, { now: new Date() });
  assert.deepEqual(pretend.sent.map((m) => m.to).sort(), [
    'r@rc-1a2b.example',
    'release@release-check.usetipme.xyz',
  ]);
  assert.deepEqual(
    real.sent.map((m) => m.to),
    ['tobi@realmail.com'],
  );
});

// Announcements daily cap (owner, 15 Nov 2026): Brevo's free plan sends 300 a day and answers
// "not enough credits" once they are used. That is a pause, not a failure: the email waits an hour
// at a time, as long as it takes, without using up its attempts, and goes once credits are back.
function announcementSender(outcomes) {
  const sent = [];
  let calls = 0;
  return {
    sent,
    calls: () => calls,
    provider: {
      name: 'brevo',
      capabilities: { marketing: true },
      async send(mail) {
        calls += 1;
        const next = outcomes.shift() ?? { ok: true };
        if (next.quota) throw new MailQuotaError('not_enough_credits');
        sent.push(mail);
        return { providerMessageId: `b-${sent.length}` };
      },
      verifyWebhook: () => ({ ok: false, reason: 'signature' }),
      async status() {
        return { sandbox: null, detail: null };
      },
    },
  };
}

const notice = (key) => ({
  type: 'service_notice',
  to: `reader.${key}@example.com`,
  userId: null,
  data: { subject: 'Fees', preheader: '', text: 'Fees change' },
  dedupeKey: `notice.quota.${key}`,
});

test('out of credits defers the email an hour at a time and never uses up its attempts', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, notice('a'));
  const zepto = scripted([]);
  const brevo = announcementSender(
    Array.from({ length: MAIL_BACKOFF_MS.length + 4 }, () => ({ quota: true })),
  );
  const both = {
    ...deps(db, zepto.provider),
    announcementProvider: brevo.provider,
  };
  let now = new Date();
  for (let i = 0; i < MAIL_BACKOFF_MS.length + 4; i++) {
    const result = await deliverDueMail(both, { now, limit: 20 });
    assert.equal(result.failed, 0);
    const [row] = await rows(
      'SELECT status, attempts, next_attempt_at, last_error FROM mail_messages WHERE id = $1',
      [id],
    );
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 0);
    assert.equal(row.last_error, 'not_enough_credits');
    assert.equal(
      row.next_attempt_at.getTime(),
      now.getTime() + MAIL_QUOTA_RETRY_MS,
    );
    // Not due again before the hour is up.
    assert.equal(
      (
        await deliverDueMail(both, {
          now: new Date(now.getTime() + 60_000),
          limit: 20,
        })
      ).sent,
      0,
    );
    now = new Date(now.getTime() + MAIL_QUOTA_RETRY_MS);
  }
  // Credits are back: it goes.
  const result = await deliverDueMail(both, { now, limit: 20 });
  assert.equal(result.sent, 1);
  const [row] = await rows(
    'SELECT status, attempts FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.deepEqual(row, { status: 'sent', attempts: 1 });
  assert.equal(zepto.sent.length, 0);
});

test('once credits run out, the rest of the pass waits without asking again; other mail still goes', async (t) => {
  const { db, rows } = await fresh(t);
  for (const key of ['a', 'b', 'c'])
    await enqueueMail(db, sealing, notice(key));
  await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.beside_quota',
  });
  const zepto = scripted([]);
  const brevo = announcementSender([{ quota: true }]);
  const now = new Date();
  const result = await deliverDueMail(
    { ...deps(db, zepto.provider), announcementProvider: brevo.provider },
    { now, limit: 20 },
  );
  assert.equal(brevo.calls(), 1);
  assert.equal(result.failed, 0);
  assert.equal(zepto.sent.length, 1);
  const waiting = await rows(
    `SELECT status, attempts, next_attempt_at FROM mail_messages WHERE type = 'service_notice'`,
  );
  assert.equal(waiting.length, 3);
  for (const row of waiting) {
    assert.equal(row.status, 'queued');
    assert.equal(row.attempts, 0);
    assert.equal(
      row.next_attempt_at.getTime(),
      now.getTime() + MAIL_QUOTA_RETRY_MS,
    );
  }
});

// Brevo for codes and receipts (owner, 23 Nov 2026), switched to by hand: with Brevo active, other
// mail goes through the transactional instance from its own type's sender, while announcements
// keep their own instance and sender. Both are Brevo; nothing reaches Brevo here.
function brevoInstance(fromAddress) {
  const bodies = [];
  const provider = createBrevoProvider({
    apiKey: 'brevo-placeholder-test',
    apiBase: 'https://api.brevo.example',
    ...(fromAddress ? { fromAddress } : {}),
    webhookToken: 'brevo-webhook-token-0123456789',
    sandbox: false,
    fetchImpl: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return Response.json(
        { messageId: `<b${bodies.length}@smtp-relay.mailin.fr>` },
        { status: 201 },
      );
    },
  });
  return { provider, bodies };
}

test('with Brevo active, receipts go through its transactional instance from their own sender', async (t) => {
  const { db, rows } = await fresh(t);
  const { id } = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    data: tip,
    dedupeKey: 'tip_received.brevo',
  });
  await enqueueMail(db, sealing, notice('brevo'));
  const transactional = brevoInstance();
  const announcements = brevoInstance('news@usetipme.xyz');
  const result = await deliverDueMail(
    {
      ...deps(db, transactional.provider),
      announcementProvider: announcements.provider,
    },
    { now: new Date(), limit: 20 },
  );
  assert.equal(result.sent, 2);
  assert.equal(transactional.bodies.length, 1);
  const own = senderAddress(MAIL_TYPES.tip_received.sender, {
    domain: 'mail.usetipme.xyz',
    name: 'TipMe',
  });
  assert.deepEqual(transactional.bodies[0].sender, {
    email: own.address,
    name: own.name,
  });
  assert.notEqual(own.address, 'news@usetipme.xyz');
  assert.equal(
    transactional.bodies[0].headers['X-Mailin-custom'],
    `tipme_ref:${id}`,
  );
  assert.equal(announcements.bodies.length, 1);
  assert.equal(announcements.bodies[0].sender.email, 'news@usetipme.xyz');
  const [row] = await rows(
    'SELECT provider, provider_message_id FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.deepEqual(row, {
    provider: 'brevo',
    provider_message_id: '<b1@smtp-relay.mailin.fr>',
  });
});
