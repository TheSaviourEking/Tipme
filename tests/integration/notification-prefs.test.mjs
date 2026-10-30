import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { WEB, browserHeaders, signIn, startStack } from './helpers.mjs';

// Notification preferences (PR-013, PRD v1.1 FR-05 "basic notification preferences"): tip emails,
// weekly-report notices and milestone notices can each be turned off. In-app tip notices,
// sign-in codes and security messages always go.
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      RATE_LIMIT_AUTH_PER_HOUR: '1000',
      RATE_LIMIT_QUOTES_PER_MIN: '1000',
      RATE_LIMIT_INTENTS_PER_MIN: '1000',
    },
  });
});
after(async () => {
  await stack.stop();
  await database.close();
});

const call = (method, path, cookie, body) =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: method === 'GET' ? { cookie } : browserHeaders(cookie),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** A live page whose owner has a verified email address. */
async function recipient(phone, handle) {
  const { cookie } = await signIn(stack.api, phone);
  await call('POST', '/v1/me/page', cookie, { handle });
  await call('PUT', '/v1/me/page/state', cookie, { state: 'live' });
  await database.pool.query(
    `UPDATE users SET email = $1, email_verified_at = now() WHERE phone_e164 = $2`,
    [`${handle}@example.test`, phone],
  );
  const { rows } = await database.pool.query(
    `SELECT id FROM users WHERE phone_e164 = $1`,
    [phone],
  );
  return { cookie, userId: rows[0].id };
}

async function tip(handle) {
  const quote = await (
    await fetch(`${stack.api}/v1/tip-quotes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, amountMinor: '200000', currency: 'NGN' }),
    })
  ).json();
  const intent = await (
    await fetch(`${stack.api}/v1/tip-intents`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': randomUUID(),
      },
      body: JSON.stringify({ quoteId: quote.data.quoteId }),
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await fetch(`${stack.api}/v1/mock-provider/checkout/${reference}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ outcome: 'succeed' }),
  });
}

const kinds = async (userId) =>
  (
    await database.pool.query(
      `SELECT kind FROM notifications WHERE user_id = $1 ORDER BY kind`,
      [userId],
    )
  ).rows.map((r) => r.kind);
const emails = async (userId) =>
  (
    await database.pool.query(
      `SELECT type FROM mail_messages WHERE user_id = $1 ORDER BY type`,
      [userId],
    )
  ).rows.map((r) => r.type);

async function settle(userId, wanted) {
  for (let i = 0; i < 80; i++) {
    if ((await kinds(userId)).includes(wanted)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('preferences default to on, and only true/false for the three known ones are accepted', async () => {
  const { cookie } = await recipient('+2348031290001', 'prefs_read');
  const prefs = await (
    await call('GET', '/v1/me/notification-preferences', cookie)
  ).json();
  assert.deepEqual(prefs.data, {
    tipEmails: true,
    weeklyReports: true,
    milestones: true,
  });
  for (const body of [
    { tipEmails: 'no', weeklyReports: true, milestones: true },
    {
      tipEmails: true,
      weeklyReports: true,
      milestones: true,
      signInCodes: false,
    },
    { tipEmails: true },
  ])
    assert.equal(
      (await call('PUT', '/v1/me/notification-preferences', cookie, body))
        .status,
      400,
      JSON.stringify(body),
    );
});

test('turned off: no tip email, no milestone notice, no weekly-report notice or email; the in-app tip notice and the report itself stay', async () => {
  const quiet = await recipient('+2348031290002', 'prefs_quiet');
  const loud = await recipient('+2348031290003', 'prefs_loud');
  const saved = await call(
    'PUT',
    '/v1/me/notification-preferences',
    quiet.cookie,
    { tipEmails: false, weeklyReports: false, milestones: false },
  );
  assert.equal(saved.status, 200);
  assert.deepEqual((await saved.json()).data, {
    tipEmails: false,
    weeklyReports: false,
    milestones: false,
  });

  await tip('prefs_quiet');
  await tip('prefs_loud');
  await settle(quiet.userId, 'tip');
  await settle(loud.userId, 'moment');

  // The current week: the tips above count.
  const now = new Date();
  const thursday = new Date(now);
  thursday.setUTCDate(now.getUTCDate() + 3 - ((now.getUTCDay() + 6) % 7));
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7);
  const isoWeek = `${thursday.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  for (const handle of ['prefs_quiet', 'prefs_loud'])
    await fetch(`${stack.api}/v1/dev/jobs/weekly-report`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle, isoWeek }),
    });

  assert.deepEqual(await kinds(loud.userId), [
    'moment',
    'tip',
    'weekly_report',
  ]);
  assert.equal((await emails(loud.userId)).length, 2, 'tip and weekly emails');
  assert.deepEqual(
    await kinds(quiet.userId),
    ['tip'],
    'only the in-app tip notice',
  );
  assert.deepEqual(await emails(quiet.userId), []);
  const { rows } = await database.pool.query(
    `SELECT count(*)::int AS n FROM weekly_reports r JOIN profiles p ON p.id = r.profile_id WHERE p.handle_lower = 'prefs_quiet'`,
  );
  assert.equal(rows[0].n, 1, 'the report itself is still made');
});
