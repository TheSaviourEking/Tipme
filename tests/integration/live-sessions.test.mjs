import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  WEB,
  browserHeaders,
  openEventStream,
  signIn,
  startStack,
  uniquePrefix,
} from './helpers.mjs';

// Every path that ends someone's sessions also closes their open live streams (spec §9, threat
// model P10): changing the email, changing the phone, a phone recovery at sign-in, and an email
// recovery finished by the worker. Each stream must hear session.ended and close.
// This file resets its database once, in before(): run it alone or with --test-concurrency=1 on a
// shared database (pnpm test:integration gives each file its own).
startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

let database;
let stack;
const apiEnv = {
  WEB_ORIGIN: WEB,
  LIVE_UPDATES_ENABLED: 'true',
  RATE_LIMIT_AUTH_PER_HOUR: '1000',
  RATE_LIMIT_LIVE_CONNECT_PER_MIN: '100000',
};
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  stack = await startStack({ databaseUrl: database.url, apiEnv });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const ENDED = /^data: \{"type":"session.ended"\}$/;
const READY = /^data: \{"type":"ready"\}$/;
const post = (path, body, cookie, method = 'POST') =>
  fetch(`${stack.api}${path}`, {
    method,
    headers: browserHeaders(cookie),
    body: JSON.stringify(body),
  });
const stream = (cookie) =>
  openEventStream(`${stack.api}/v1/me/events`, { cookie, origin: WEB });
const cookiesOf = (response) =>
  response.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');

const usedMail = new Set();
/** The next unread message to `hint` whose subject matches, once the worker has sent it. */
async function codeTo(hint, subject) {
  for (let i = 0; i < 100; i++) {
    const { data } = await (await fetch(`${stack.api}/v1/dev/inbox`)).json();
    const mail = data.find(
      (m) =>
        m.to === hint &&
        (!subject || m.subject?.toLowerCase().includes(subject)) &&
        !usedMail.has(m.id),
    );
    if (mail) {
      usedMail.add(mail.id);
      return /\b(\d{6})\b/.exec(mail.body)[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no message to ${hint}`);
}
const emailHint = (email) => {
  const [local, domain] = email.split('@');
  return `${local[0]}•••@${domain}`;
};
async function emailSignIn(email) {
  assert.equal((await post('/v1/auth/code', { email })).status, 202);
  const code = await codeTo(emailHint(email), 'sign-in code');
  const verify = await post('/v1/auth/verify', { email, code });
  assert.equal(verify.status, 200);
  return {
    cookie: cookiesOf(verify),
    userId: (await verify.json()).data.userId,
  };
}
let phones = 0;
const nextPhone = () =>
  `+2348034${String(400000 + (phones += 1)).padStart(6, '0')}`;

/** Opens a stream on `cookie`, waits for ready, and returns it. */
async function openReady(cookie) {
  const s = await stream(cookie);
  assert.equal(s.status, 200);
  await s.waitFor(READY);
  return s;
}

test('changing the email closes the other session’s stream with session.ended', async () => {
  const oldEmail = `a@${uniquePrefix()}.example`;
  const newEmail = `a@${uniquePrefix()}.example`;
  const here = await emailSignIn(oldEmail);
  const there = await emailSignIn(oldEmail);
  const theirs = await openReady(there.cookie);
  const mine = await openReady(here.cookie);
  assert.equal(
    (await post('/v1/me/email/code', { email: newEmail }, here.cookie)).status,
    202,
  );
  const code = await codeTo(emailHint(newEmail), 'new tipme email');
  assert.equal(
    (await post('/v1/me/email/confirm', { email: newEmail, code }, here.cookie))
      .status,
    200,
  );
  await theirs.waitFor(ENDED);
  await theirs.ended;
  // The session that made the change keeps its stream.
  assert.equal(
    mine.frames.some((f) => ENDED.test(f)),
    false,
  );
  mine.close();
});

test('changing the phone closes the other session’s stream with session.ended', async () => {
  const phone = nextPhone();
  const here = await signIn(stack.api, phone);
  const there = await signIn(stack.api, phone);
  const handle = `ls_${randomUUID().slice(0, 8)}`;
  assert.equal(
    (await post('/v1/me/page', { handle }, here.cookie)).status,
    201,
  );
  const theirs = await openReady(there.cookie);
  const newPhone = nextPhone();
  assert.equal(
    (await post('/v1/me/phone/code', { phone: newPhone }, here.cookie)).status,
    202,
  );
  const code = await codeTo(`•••${newPhone.slice(-4)}`);
  const changed = await post(
    '/v1/me/phone',
    { phone: newPhone, code },
    here.cookie,
    'PUT',
  );
  assert.equal(changed.status, 200, await changed.text());
  await theirs.waitFor(ENDED);
  await theirs.ended;
});

test('a phone recovery at sign-in closes the recovered account’s streams', async () => {
  const email = `a@${uniquePrefix()}.example`;
  const owner = await emailSignIn(email);
  const theirs = await openReady(owner.cookie);
  // A recovery whose hold has ended: the next sign-in with this number takes the account.
  const phone = nextPhone();
  await database.pool.query(
    `INSERT INTO phone_recoveries (id, user_id, new_phone_e164, effective_at, created_at)
     VALUES ($1, $2, $3, now() - interval '1 minute', now() - interval '2 days')`,
    [randomUUID(), owner.userId, phone],
  );
  const recovered = await signIn(stack.api, phone);
  assert.equal(recovered.body.data.userId, owner.userId);
  await theirs.waitFor(ENDED);
  await theirs.ended;
});

test('an email recovery finished by the worker closes the account’s streams', async () => {
  const email = `a@${uniquePrefix()}.example`;
  const owner = await emailSignIn(email);
  const theirs = await openReady(owner.cookie);
  await database.pool.query(
    `INSERT INTO email_recoveries
       (id, user_id, new_email, started_by, confirmed_at, effective_at, created_at)
     VALUES ($1, $2, $3, 'self', now() - interval '2 days', now() - interval '1 minute',
             now() - interval '2 days')`,
    [randomUUID(), owner.userId, `b@${uniquePrefix()}.example`],
  );
  // The worker finishes due recoveries once a minute, and at once when it starts: a second
  // worker on the same queue prefix (so the same live channel) does it now.
  const second = await startStack({
    databaseUrl: database.url,
    prefix: stack.prefix,
    apiEnv,
  });
  try {
    await theirs.waitFor(ENDED, 15_000);
    await theirs.ended;
    const { rows } = await database.pool.query(
      `SELECT completed_at FROM email_recoveries WHERE user_id = $1`,
      [owner.userId],
    );
    assert.ok(rows[0].completed_at, 'the recovery completed');
  } finally {
    await second.stop();
  }
});
