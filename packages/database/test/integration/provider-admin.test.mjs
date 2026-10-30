import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  activeMailProvider,
  addressHmac,
  confirmProviderTest,
  deliverDueMail,
  DEMO_PROFILES,
  mailProviderOverview,
  mailOverrideFor,
  mailSealing,
  removeProviderOverride,
  removeSuppression,
  setProviderOverride,
  startMailProviderTest,
  switchMailProvider,
} from '../../dist/index.js';
import { queuedMail } from '../../dist/test-support.js';
import { useDatabase } from './helpers.mjs';

// A provider becomes active only after a test email through it was confirmed as received.

const sealing = mailSealing(Buffer.alloc(32, 7));
const STAFF = '00000000-0000-7000-8000-000000007b11';
const USER = DEMO_PROFILES[0].userId;
const configured = new Set(['mock', 'zeptomail', 'ses']);
const base = {
  staffUserId: STAFF,
  reason: 'moving to the launch provider',
  production: false,
  sandbox: null,
  configured,
  fallback: 'mock',
};

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

async function confirmedTest(db, provider, now) {
  await startMailProviderTest(db, sealing, {
    staffUserId: STAFF,
    provider,
    to: 'staff@example.com',
    webOrigin: 'https://usetipme.xyz',
    reason: 'checking this provider before use',
    now,
  });
  const [mail] = await queuedMail(db, sealing, { limit: 1 });
  return confirmProviderTest(db, {
    token: mail.data.token,
    staffUserId: STAFF,
    now,
  });
}

test('the test email is pinned to its provider and carries the confirmation token', async (t) => {
  const { db, rows } = await fresh(t);
  const { testId } = await startMailProviderTest(db, sealing, {
    staffUserId: STAFF,
    provider: 'ses',
    to: 'staff@example.com',
    webOrigin: 'https://usetipme.xyz',
    reason: 'checking this provider before use',
  });
  const [mail] = await queuedMail(db, sealing, { limit: 1 });
  assert.equal(mail.type, 'provider_test');
  assert.equal(mail.data.providerLabel, 'Amazon SES');
  const [row] = await rows(
    'SELECT m.pinned_provider, t.status, t.target_hint, t.token_sha256 FROM provider_tests t JOIN mail_messages m ON m.id = t.message_id WHERE t.id = $1',
    [testId],
  );
  assert.equal(row.pinned_provider, 'ses');
  assert.equal(row.status, 'pending');
  assert.equal(row.target_hint, 's•••@example.com');
  assert.notEqual(row.token_sha256, mail.data.token, 'only a hash is stored');
});

test('a provider can be made active only with a test confirmed in the last 24 hours', async (t) => {
  const { db } = await fresh(t);
  assert.equal(
    await switchMailProvider(db, { ...base, provider: 'ses' }),
    'no_confirmed_test',
  );
  assert.equal(await confirmedTest(db, 'ses'), 'confirmed');
  assert.equal(
    await switchMailProvider(db, { ...base, provider: 'ses' }),
    'switched',
  );
  assert.equal(await activeMailProvider(db, 'mock'), 'ses');
});

test('a confirmed test older than 24 hours does not count', async (t) => {
  const { db } = await fresh(t);
  await confirmedTest(db, 'zeptomail', new Date(Date.now() - 25 * 3_600_000));
  assert.equal(
    await switchMailProvider(db, { ...base, provider: 'zeptomail' }),
    'no_confirmed_test',
  );
});

test('a test for another provider does not count, and a bad token confirms nothing', async (t) => {
  const { db } = await fresh(t);
  await confirmedTest(db, 'zeptomail');
  assert.equal(
    await switchMailProvider(db, { ...base, provider: 'ses' }),
    'no_confirmed_test',
  );
  assert.equal(
    await confirmProviderTest(db, { token: 'nope', staffUserId: STAFF }),
    'invalid',
  );
});

test('a test link stops working after 24 hours and after its first use', async (t) => {
  const { db } = await fresh(t);
  const then = new Date(Date.now() - 25 * 3_600_000);
  await startMailProviderTest(db, sealing, {
    staffUserId: STAFF,
    provider: 'ses',
    to: 'staff@example.com',
    webOrigin: 'https://usetipme.xyz',
    reason: 'checking this provider before use',
    now: then,
  });
  const [mail] = await queuedMail(db, sealing, { limit: 1 });
  assert.equal(
    await confirmProviderTest(db, {
      token: mail.data.token,
      staffUserId: STAFF,
    }),
    'invalid',
  );
  await startMailProviderTest(db, sealing, {
    staffUserId: STAFF,
    provider: 'ses',
    to: 'staff@example.com',
    webOrigin: 'https://usetipme.xyz',
    reason: 'checking this provider before use',
  });
  const [second] = await queuedMail(db, sealing, { limit: 1 });
  const once = { token: second.data.token, staffUserId: STAFF };
  assert.equal(await confirmProviderTest(db, once), 'confirmed');
  assert.equal(await confirmProviderTest(db, once), 'invalid');
});

test('mock cannot be made active in production', async (t) => {
  const { db } = await fresh(t);
  await confirmedTest(db, 'mock');
  assert.equal(
    await switchMailProvider(db, {
      ...base,
      provider: 'mock',
      production: true,
    }),
    'refused_in_production',
  );
});

test('SES in sandbox cannot be made active in production, but can elsewhere', async (t) => {
  const { db } = await fresh(t);
  await confirmedTest(db, 'ses');
  assert.equal(
    await switchMailProvider(db, {
      ...base,
      provider: 'ses',
      production: true,
      sandbox: true,
    }),
    'refused_in_production',
  );
  assert.equal(
    await switchMailProvider(db, { ...base, provider: 'ses', sandbox: true }),
    'switched',
  );
});

test('an unconfigured provider cannot be made active', async (t) => {
  const { db } = await fresh(t);
  await confirmedTest(db, 'ses');
  assert.equal(
    await switchMailProvider(db, {
      ...base,
      provider: 'ses',
      configured: new Set(['mock']),
    }),
    'not_configured',
  );
});

test('with no choice made, the server default is active', async (t) => {
  const { db } = await fresh(t);
  assert.equal(await activeMailProvider(db, 'zeptomail'), 'zeptomail');
});

test('switches, overrides and suppression removals are audited with the reason', async (t) => {
  const { db, rows } = await fresh(t);
  await confirmedTest(db, 'ses');
  await switchMailProvider(db, { ...base, provider: 'ses' });
  await setProviderOverride(db, {
    kind: 'mail',
    userId: USER,
    provider: 'zeptomail',
    staffUserId: STAFF,
    reason: 'their mailbox rejects SES',
  });
  assert.equal(await mailOverrideFor(db, USER), 'zeptomail');
  assert.equal(
    await removeProviderOverride(db, {
      kind: 'mail',
      userId: USER,
      staffUserId: STAFF,
      reason: 'no longer needed here',
    }),
    true,
  );
  assert.equal(await mailOverrideFor(db, USER), null);
  await db.execute(
    `INSERT INTO mail_suppressions (address_hmac, reason) VALUES ('${addressHmac(sealing, 'a@example.com')}', 'hard_bounce')`,
  );
  assert.equal(
    await removeSuppression(db, sealing, {
      address: 'A@example.com',
      staffUserId: STAFF,
      reason: 'mailbox fixed by the user',
      confirmComplaint: false,
    }),
    'removed',
  );
  const audit = await rows(
    `SELECT action, reason FROM audit_events WHERE action LIKE 'mail%' ORDER BY seq`,
  );
  assert.deepEqual(
    audit.map((a) => a.action),
    [
      'mail_provider.test_started',
      'mail_provider.test_confirmed',
      'mail_provider.switched',
      'mail_provider.override_set',
      'mail_provider.override_removed',
      'mail.suppression_removed',
    ],
  );
  assert.equal(audit[0].reason, 'checking this provider before use');
  assert.equal(audit[2].reason, `From mock to ses: ${base.reason}`);
  assert.equal(audit[3].reason, 'zeptomail: their mailbox rejects SES');
});

test('a complaint suppression needs explicit confirmation to remove', async (t) => {
  const { db, rows } = await fresh(t);
  await db.execute(
    `INSERT INTO mail_suppressions (address_hmac, reason) VALUES ('${addressHmac(sealing, 'a@example.com')}', 'complaint')`,
  );
  const input = {
    address: 'a@example.com',
    staffUserId: STAFF,
    reason: 'they asked to receive email again',
  };
  assert.equal(
    await removeSuppression(db, sealing, { ...input, confirmComplaint: false }),
    'complaint_needs_confirmation',
  );
  assert.equal(
    await removeSuppression(db, sealing, { ...input, confirmComplaint: true }),
    'removed',
  );
  assert.equal(
    await removeSuppression(db, sealing, { ...input, confirmComplaint: true }),
    'not_found',
  );
  assert.equal((await rows('SELECT * FROM mail_suppressions')).length, 0);
});

test('an existing owner role receives the new permissions from the migration', async (t) => {
  const { rows } = await fresh(t);
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../drizzle/', import.meta.url);
  const file = readdirSync(dir).find((f) => f.endsWith('_provider_admin.sql'));
  const sql = readFileSync(new URL(file, dir), 'utf8');
  assert.match(sql, /INSERT INTO "role_permissions"/);
  assert.match(sql, /providers\.manage/);
  assert.match(sql, /recoveries\.manage/);
  assert.equal((await rows(`SELECT 1 FROM provider_settings`)).length, 0);
});

const failing = (error) => ({
  name: 'ses',
  capabilities: { marketing: true },
  async send() {
    throw error;
  },
  verifyWebhook: () => ({ ok: false, reason: 'signature' }),
  status: async () => ({ sandbox: null, detail: null }),
});
const deliver = (db, provider) =>
  deliverDueMail(
    {
      db,
      sealing,
      providers: new Map([['ses', provider]]),
      activeProvider: async () => 'ses',
      overrideFor: async () => null,
      from: { address: 'h@example.com', name: 'T' },
      webOrigin: 'https://usetipme.xyz',
      apiOrigin: 'https://api.usetipme.xyz',
    },
    { now: new Date(), limit: 5 },
  );
const startTest = (db, now) =>
  startMailProviderTest(db, sealing, {
    staffUserId: STAFF,
    provider: 'ses',
    to: 'staff@example.com',
    webOrigin: 'https://usetipme.xyz',
    reason: 'checking this provider before use',
    ...(now ? { now } : {}),
  });
const lastTest = async (db) =>
  (await mailProviderOverview(db, { configured: ['ses'], fallback: 'ses' }))
    .providers[0].lastTest;

test('a test still goes to an address blocked for a complaint or soft bounces, not a hard bounce', async (t) => {
  const { db, rows } = await fresh(t);
  const block = (reason) =>
    db.execute(
      `INSERT INTO mail_suppressions (address_hmac, reason) VALUES ('${addressHmac(sealing, 'staff@example.com')}', '${reason}')
       ON CONFLICT (address_hmac) DO UPDATE SET reason = EXCLUDED.reason`,
    );
  const sent = [];
  const ok = {
    ...failing(null),
    async send(mail) {
      sent.push(mail);
      return { providerMessageId: 'x' };
    },
  };
  await block('complaint');
  await startTest(db);
  await deliver(db, ok);
  assert.equal(sent.length, 1);
  await block('hard_bounce');
  await startTest(db);
  await deliver(db, ok);
  assert.equal(sent.length, 1);
  const [row] = await rows(
    `SELECT status FROM mail_messages ORDER BY created_at DESC, id DESC LIMIT 1`,
  );
  assert.equal(row.status, 'suppressed');
});

test('a test whose email was refused says so, instead of waiting forever', async (t) => {
  const { db } = await fresh(t);
  const { MailRejectedError } = await import('@tipme/mail');
  await startTest(db);
  await deliver(db, failing(new MailRejectedError('SM_111')));
  const test = await lastTest(db);
  assert.equal(test.status, 'failed');
  assert.equal(test.failureCode, 'SM_111');
});

test('a test being retried shows why', async (t) => {
  const { db } = await fresh(t);
  const { MailTemporaryError } = await import('@tipme/mail');
  await startTest(db);
  await deliver(db, failing(new MailTemporaryError('busy')));
  const test = await lastTest(db);
  assert.equal(test.status, 'pending');
  assert.equal(test.messageStatus, 'queued');
  assert.equal(test.failureCode, 'busy');
});

test('a test nobody confirmed for 24 hours reads as expired', async (t) => {
  const { db } = await fresh(t);
  await startTest(db, new Date(Date.now() - 25 * 3_600_000));
  assert.equal((await lastTest(db)).status, 'expired');
});
