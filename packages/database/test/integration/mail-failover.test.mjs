import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createMailHealth,
  MailQuotaError,
  MailRejectedError,
  MailTemporaryError,
  memoryMailHealthStore,
} from '@tipme/mail';
import {
  checkCodeDelivery,
  deliverDueMail,
  enqueueMail,
  mailFailoverFixed,
  mailSealing,
  requestEmailSignInCode,
  setMailFailoverFixed,
  startMailProviderTest,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Automatic failover between ZeptoMail and Brevo (owner, 23 Nov 2026). On 23 Nov ZeptoMail took 8
// emails (sign-in codes among them) and never delivered them; nothing noticed. Now (a) a definite
// send failure moves the mail on at once and 3 in 5 minutes rest the provider; (b) too many unused
// codes rest it too; (c) a code asked for again goes through the other provider. A manual choice
// always wins, and without a fallback nothing changes.

const sealing = mailSealing(Buffer.alloc(32, 7));
const SECRET = 'integration-auth-code-secret-32-characters';
const STAFF = '00000000-0000-7000-8000-000000007b11';
const T0 = new Date('2026-11-23T10:00:00Z');
const at = (ms) => new Date(T0.getTime() + ms);
const SETTINGS = {
  threshold: 3,
  windowMs: 300_000,
  restMs: 900_000,
  trialCodes: 3,
};
const CODE_SETTINGS = {
  unusedAfterMs: 180_000,
  windowMs: 600_000,
  minSamples: 5,
  unusedRatio: 0.6,
  trialCodes: 3,
};

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

/** A provider whose next sends do what the test says (by default, they succeed). */
function scripted(name, outcomes = []) {
  const sent = [];
  let calls = 0;
  return {
    sent,
    calls: () => calls,
    push: (...more) => outcomes.push(...more),
    provider: {
      name,
      capabilities: { marketing: false },
      async send(mail) {
        calls += 1;
        const next = outcomes.shift() ?? { ok: true };
        if (next.rejected) throw new MailRejectedError(next.rejected);
        if (next.definite) throw new MailTemporaryError(next.definite);
        if (next.quota) throw new MailQuotaError(next.quota);
        if (next.ambiguous)
          throw new MailTemporaryError(next.ambiguous, { ambiguous: true });
        sent.push(mail);
        return { providerMessageId: `${name}-${sent.length}` };
      },
      verifyWebhook: () => ({ ok: false, reason: 'signature' }),
      async status() {
        return { sandbox: null, detail: null };
      },
    },
  };
}

/** The clock the breaker reads, moved with each pass's `now`. */
function clock() {
  let now = T0;
  return { set: (d) => (now = d), now: () => now };
}

function setup(db, options = {}) {
  const zepto = scripted('zeptomail', options.zepto);
  const brevo = scripted('brevo', options.brevo);
  const c = clock();
  const changes = [];
  const store = options.store ?? memoryMailHealthStore(SETTINGS);
  const health = createMailHealth({
    store,
    settings: SETTINGS,
    clock: c.now,
    onChange: async (change) => {
      changes.push(change);
    },
  });
  let active = options.active ?? 'zeptomail';
  const deps = {
    db,
    sealing,
    providers: new Map([
      ['zeptomail', zepto.provider],
      ['brevo', brevo.provider],
    ]),
    activeProvider: async () => active,
    overrideFor: options.overrideFor ?? (async () => null),
    sender: { domain: 'mail.usetipme.xyz', name: 'TipMe' },
    webOrigin: 'http://localhost:3000',
    apiOrigin: 'http://localhost:4000',
    ...(options.noFailover
      ? {}
      : {
          failover: {
            health,
            fallbacks: options.fallbacks ?? ['brevo'],
            defaultProvider: 'zeptomail',
            production: false,
            fixed: () => mailFailoverFixed(db),
            resendWindowMs: 600_000,
          },
        }),
  };
  const deliver = (now) => {
    c.set(now);
    return deliverDueMail(deps, { now, limit: 20 });
  };
  const check = (now) => {
    c.set(now);
    return checkCodeDelivery(db, {
      health,
      providers: ['zeptomail', 'brevo'],
      now,
      settings: CODE_SETTINGS,
    });
  };
  const view = async (name, now) => {
    c.set(now);
    return (await health.snapshot([name])).get(name);
  };
  return {
    zepto,
    brevo,
    changes,
    health,
    deliver,
    check,
    view,
    setActive: (name) => (active = name),
  };
}

let seq = 0;
const receipt = (db, now = T0) =>
  enqueueMail(db, sealing, {
    type: 'tip_received',
    to: `tobi${++seq}@gmail.com`,
    data: {
      firstName: 'Tobi',
      netMinor: '180000',
      supporterLabel: 'Ada',
      pretendPayment: true,
    },
    dedupeKey: `tip_received.${seq}`,
    now,
  });

const signIn = (db, email, now) =>
  requestEmailSignInCode(db, sealing, { email, secret: SECRET, now });

const providerOf = async (rows, id) =>
  (
    await rows('SELECT provider, status FROM mail_messages WHERE id = $1', [id])
  )[0];

test('with no fallback configured nothing changes: a failure waits for its retry and Brevo is never tried', async (t) => {
  const { db, rows } = await fresh(t);
  for (const variant of [{ noFailover: true }, { fallbacks: [] }]) {
    const calls = [];
    const spy = new Proxy(memoryMailHealthStore(SETTINGS), {
      get: (target, key) => {
        calls.push(key);
        return target[key];
      },
    });
    const s = setup(db, {
      ...variant,
      store: spy,
      zepto: [{ definite: 'http_503' }],
    });
    const { id } = await receipt(db);
    const result = await s.deliver(T0);
    assert.equal(result.retried, 1);
    assert.equal(s.brevo.calls(), 0);
    assert.deepEqual(await providerOf(rows, id), {
      provider: 'zeptomail',
      status: 'queued',
    });
    assert.deepEqual(calls, [], 'the breaker is never asked');
    await rows("UPDATE mail_messages SET status = 'failed' WHERE id = $1", [
      id,
    ]);
  }
});

test('a definite failure sends the same mail through the backup at once, and the row says who sent it', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db, { zepto: [{ definite: 'timeout' }] });
  const { id } = await receipt(db);
  const result = await s.deliver(T0);
  assert.equal(result.sent, 1);
  assert.equal(s.brevo.sent.length, 1);
  assert.deepEqual(await providerOf(rows, id), {
    provider: 'brevo',
    status: 'sent',
  });
  const events = await rows(
    'SELECT kind, provider FROM mail_message_events WHERE message_id = $1 ORDER BY occurred_at, kind',
    [id],
  );
  assert.deepEqual(
    events.map((e) => [e.kind, e.provider]),
    [
      ['queued', null],
      ['send_failed', 'zeptomail'],
      ['sent', 'brevo'],
    ],
  );
});

test('a refusal of the mail itself, or an answer that may hide an accepted mail, never moves it', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db, {
    zepto: [{ rejected: 'SM_113' }, { ambiguous: 'no_request_id' }],
  });
  const bad = await receipt(db);
  const unsure = await receipt(db);
  await s.deliver(T0);
  assert.equal(s.brevo.calls(), 0);
  assert.deepEqual(await providerOf(rows, bad.id), {
    provider: 'zeptomail',
    status: 'failed',
  });
  assert.deepEqual(await providerOf(rows, unsure.id), {
    provider: 'zeptomail',
    status: 'queued',
  });
  assert.equal((await s.view('zeptomail', T0)).state, 'healthy');
});

test('three definite failures in five minutes rest ZeptoMail: new mail goes to Brevo, staff are told once', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db, {
    zepto: [
      { definite: 'http_503' },
      { definite: 'http_503' },
      { definite: 'http_502' },
    ],
  });
  for (let i = 0; i < 3; i++) await receipt(db);
  await s.deliver(T0);
  assert.equal(s.brevo.sent.length, 3);
  const resting = await s.view('zeptomail', at(1000));
  assert.equal(resting.state, 'resting');
  assert.equal(resting.reason, '3 send failures in 5 min (last: http_502)');
  assert.deepEqual(
    s.changes.map((x) => [x.provider, x.change]),
    [['zeptomail', 'tripped']],
  );
  // Resting: ZeptoMail isn't even asked.
  const { id } = await receipt(db, at(60_000));
  await s.deliver(at(60_000));
  assert.equal(s.zepto.calls(), 3);
  assert.deepEqual(await providerOf(rows, id), {
    provider: 'brevo',
    status: 'sent',
  });
  // After 15 minutes one probe goes to ZeptoMail; it works, so it is back.
  const probe = await receipt(db, at(901_000));
  const next = await receipt(db, at(901_000));
  await s.deliver(at(901_000));
  assert.equal((await providerOf(rows, probe.id)).provider, 'zeptomail');
  assert.equal((await providerOf(rows, next.id)).provider, 'zeptomail');
  assert.equal((await s.view('zeptomail', at(901_000))).state, 'healthy');
  assert.deepEqual(
    s.changes.map((x) => x.change),
    ['tripped', 'recovered'],
  );
});

test('a failed probe rests ZeptoMail again; the probe mail itself still goes out through Brevo', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db, {
    zepto: [
      { definite: 'x' },
      { definite: 'x' },
      { definite: 'x' },
      { definite: 'http_500' },
    ],
  });
  for (let i = 0; i < 3; i++) await receipt(db);
  await s.deliver(T0);
  const probe = await receipt(db, at(901_000));
  await s.deliver(at(901_000));
  assert.deepEqual(await providerOf(rows, probe.id), {
    provider: 'brevo',
    status: 'sent',
  });
  const view = await s.view('zeptomail', at(902_000));
  assert.equal(view.state, 'resting');
  assert.equal(view.until.toISOString(), at(901_000 + 900_000).toISOString());
});

test('when staff fix the provider in ops nothing moves automatically', async (t) => {
  const { db, rows } = await fresh(t);
  await setMailFailoverFixed(db, {
    staffUserId: STAFF,
    fixed: true,
    reason: 'Investigating ZeptoMail',
    fallback: 'zeptomail',
    now: T0,
  });
  assert.equal(await mailFailoverFixed(db), true);
  const s = setup(db, { zepto: [{ definite: 'http_503' }] });
  const { id } = await receipt(db);
  await s.deliver(T0);
  assert.equal(s.brevo.calls(), 0);
  assert.deepEqual(await providerOf(rows, id), {
    provider: 'zeptomail',
    status: 'queued',
  });
  const [audit] = await rows(
    "SELECT action, reason FROM audit_events WHERE action LIKE 'mail_provider.failover%'",
  );
  assert.deepEqual(audit, {
    action: 'mail_provider.failover_fixed',
    reason: 'Investigating ZeptoMail',
  });
  await setMailFailoverFixed(db, {
    staffUserId: STAFF,
    fixed: false,
    reason: 'Done',
    fallback: 'zeptomail',
  });
  assert.equal(await mailFailoverFixed(db), false);
});

test('provider tests and per-person overrides stay on their one provider', async (t) => {
  const { db, rows } = await fresh(t);
  const tobi = '00000000-0000-7000-8000-000000007b11';
  const s = setup(db, {
    zepto: [{ definite: 'http_503' }, { definite: 'http_503' }],
    overrideFor: async (userId) => (userId === tobi ? 'zeptomail' : null),
  });
  await startMailProviderTest(db, sealing, {
    staffUserId: STAFF,
    provider: 'zeptomail',
    to: 'staff@gmail.com',
    webOrigin: 'http://localhost:3000',
    reason: 'Checking',
    now: T0,
  });
  const pinned = await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@gmail.com',
    userId: tobi,
    data: {
      firstName: 'Tobi',
      netMinor: '100',
      supporterLabel: 'A',
      pretendPayment: true,
    },
    dedupeKey: 'tip_received.pinned',
    now: T0,
  });
  await s.deliver(T0);
  assert.equal(s.brevo.calls(), 0);
  assert.deepEqual(await providerOf(rows, pinned.id), {
    provider: 'zeptomail',
    status: 'queued',
  });
  const [test] = await rows(
    "SELECT provider, status FROM mail_messages WHERE type = 'provider_test'",
  );
  assert.deepEqual(test, { provider: 'zeptomail', status: 'queued' });
});

test('with Brevo active, a sign-in code Brevo has no credits for goes through ZeptoMail', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db, {
    active: 'brevo',
    brevo: [{ quota: 'not_enough_credits' }],
  });
  await signIn(db, 'ada@gmail.com', T0);
  await s.deliver(T0);
  const [row] = await rows(
    "SELECT provider, status FROM mail_messages WHERE type = 'sign_in_code'",
  );
  assert.deepEqual(row, { provider: 'zeptomail', status: 'sent' });
});

test('when every provider fails for sure the mail waits for its retry, as today', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db, {
    zepto: [{ definite: 'http_503' }],
    brevo: [{ definite: 'timeout' }],
  });
  const { id } = await receipt(db);
  const result = await s.deliver(T0);
  assert.equal(result.retried, 1);
  const [row] = await rows(
    'SELECT provider, status, last_error, attempts FROM mail_messages WHERE id = $1',
    [id],
  );
  assert.deepEqual(row, {
    provider: 'brevo',
    status: 'queued',
    last_error: 'timeout',
    attempts: 1,
  });
});

test('(c) a code asked for again within 10 minutes goes through the other provider', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db);
  await signIn(db, 'ada@gmail.com', T0);
  await s.deliver(T0);
  await signIn(db, 'ada@gmail.com', at(60_000));
  await s.deliver(at(60_000));
  // Another person's first code is unaffected.
  await signIn(db, 'kemi@gmail.com', at(61_000));
  await s.deliver(at(61_000));
  const codes = await rows(
    "SELECT provider, to_hint FROM mail_messages WHERE type = 'sign_in_code' ORDER BY created_at",
  );
  assert.deepEqual(
    codes.map((c) => c.provider),
    ['zeptomail', 'brevo', 'zeptomail'],
  );
  // A third code goes back to ZeptoMail (the provider after Brevo).
  await signIn(db, 'ada@gmail.com', at(120_000));
  await s.deliver(at(120_000));
  const [third] = await rows(
    "SELECT provider FROM mail_messages WHERE type = 'sign_in_code' ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(third.provider, 'zeptomail');
});

test('(c) not after the resend window, and not to a backup that is resting', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db);
  await signIn(db, 'ada@gmail.com', T0);
  await s.deliver(T0);
  await signIn(db, 'ada@gmail.com', at(601_000));
  await s.deliver(at(601_000));
  await s.health.tripCodes('brevo', 'test');
  await signIn(db, 'ada@gmail.com', at(620_000));
  await s.deliver(at(620_000));
  const codes = await rows(
    "SELECT provider FROM mail_messages WHERE type = 'sign_in_code' ORDER BY created_at",
  );
  assert.deepEqual(
    codes.map((c) => c.provider),
    ['zeptomail', 'zeptomail', 'zeptomail'],
  );
});

/** Sends one sign-in code per address at `now`, through whatever routing picks. */
async function sendCodes(db, s, emails, now) {
  for (const email of emails) await signIn(db, email, now);
  await s.deliver(now);
}

const useCode = (rows, email, now) =>
  rows(
    `UPDATE email_codes SET consumed_at = $2
      WHERE id = (SELECT id FROM email_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1)`,
    [email, now],
  );

test('(b) one person walking away never trips it: below the sample minimum, or below the ratio', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db);
  // One person asks three times (the hourly limit) and never types a code.
  for (let i = 0; i < 3; i++)
    await sendCodes(db, s, ['ada@gmail.com'], at(i * 20_000));
  await s.check(at(400_000));
  assert.equal((await s.view('zeptomail', at(400_000))).state, 'healthy');
  // Six people, two of them walk away: with the one person's two, 4 of 8 is under 60%.
  const people = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map(
    (p) => `${p}@gmail.com`,
  );
  await sendCodes(db, s, people, at(410_000));
  for (const p of people.slice(0, 4)) await useCode(rows, p, at(420_000));
  await s.check(at(600_000));
  assert.equal((await s.view('zeptomail', at(600_000))).state, 'healthy');
  assert.deepEqual(s.changes, []);
});

test('(b) 4 of 6 codes unused in 10 minutes rest ZeptoMail; codes still waiting are not counted', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db);
  const people = ['a', 'b', 'c', 'd', 'e', 'f'].map((p) => `${p}@gmail.com`);
  await sendCodes(db, s, people, T0);
  await useCode(rows, 'a@gmail.com', at(30_000));
  await useCode(rows, 'b@gmail.com', at(40_000));
  // Too early: the others may still be on their way to being typed.
  await s.check(at(120_000));
  assert.equal((await s.view('zeptomail', at(120_000))).state, 'healthy');
  // A fresh code is pending, not unused.
  await sendCodes(db, s, ['g@gmail.com'], at(170_000));
  await s.check(at(200_000));
  const view = await s.view('zeptomail', at(200_000));
  assert.equal(view.state, 'resting');
  assert.equal(view.kind, 'codes');
  assert.equal(view.reason, '4 of 6 codes unused in 10 min');
  assert.deepEqual(
    s.changes.map((x) => [x.provider, x.change]),
    [['zeptomail', 'tripped']],
  );
  // New codes go through Brevo while it rests.
  await sendCodes(db, s, ['h@gmail.com'], at(210_000));
  const [last] = await rows(
    "SELECT provider FROM mail_messages WHERE type = 'sign_in_code' ORDER BY created_at DESC LIMIT 1",
  );
  assert.equal(last.provider, 'brevo');
});

test('(b) a code asked for again counts as unused for the earlier send at once', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db, { fallbacks: ['brevo'] });
  // Five people get a code at once; four ask again a minute later (through Brevo, rule c) and use
  // the second code. ZeptoMail's four first codes are unused without waiting 3 minutes.
  const people = ['a', 'b', 'c', 'd', 'e'].map((p) => `${p}@gmail.com`);
  await sendCodes(db, s, people, T0);
  await useCode(rows, 'e@gmail.com', at(20_000));
  await sendCodes(db, s, people.slice(0, 4), at(60_000));
  for (const p of people.slice(0, 4)) await useCode(rows, p, at(70_000));
  await s.check(at(80_000));
  const zepto = await s.view('zeptomail', at(80_000));
  assert.equal(zepto.state, 'resting');
  assert.equal(zepto.reason, '4 of 5 codes unused in 10 min');
  assert.equal((await s.view('brevo', at(80_000))).state, 'healthy');
});

async function tripOnCodes(db, rows, s) {
  const people = ['a', 'b', 'c', 'd', 'e'].map((p) => `${p}@gmail.com`);
  await sendCodes(db, s, people, T0);
  await s.check(at(200_000));
  assert.equal((await s.view('zeptomail', at(200_000))).state, 'resting');
}

test('(b) after the rest the next three codes go through ZeptoMail on trial; one used restores it', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db);
  await tripOnCodes(db, rows, s);
  const after = 200_000 + 900_000;
  // A receipt is no trial traffic for a codes trip.
  const r = await receipt(db, at(after));
  await sendCodes(
    db,
    s,
    ['t1@gmail.com', 't2@gmail.com', 't3@gmail.com', 't4@gmail.com'],
    at(after),
  );
  assert.equal((await providerOf(rows, r.id)).provider, 'brevo');
  const codes = await rows(
    "SELECT provider FROM mail_messages WHERE type = 'sign_in_code' AND created_at >= $1 ORDER BY created_at",
    [at(after)],
  );
  assert.deepEqual(
    codes.map((c) => c.provider),
    ['zeptomail', 'zeptomail', 'zeptomail', 'brevo'],
  );
  await s.check(at(after + 10_000));
  assert.equal((await s.view('zeptomail', at(after + 10_000))).state, 'trial');
  await useCode(rows, 't2@gmail.com', at(after + 20_000));
  await s.check(at(after + 30_000));
  assert.equal(
    (await s.view('zeptomail', at(after + 30_000))).state,
    'healthy',
  );
  assert.deepEqual(
    s.changes.map((x) => x.change),
    ['tripped', 'recovered'],
  );
  // The unused codes from before the trip don't trip it again.
  await s.check(at(after + 40_000));
  assert.equal(
    (await s.view('zeptomail', at(after + 40_000))).state,
    'healthy',
  );
});

test('(b) trial codes nobody uses rest ZeptoMail again', async (t) => {
  const { db, rows } = await fresh(t);
  const s = setup(db);
  await tripOnCodes(db, rows, s);
  const after = 200_000 + 900_000;
  await sendCodes(
    db,
    s,
    ['t1@gmail.com', 't2@gmail.com', 't3@gmail.com'],
    at(after),
  );
  await s.check(at(after + 181_000));
  const view = await s.view('zeptomail', at(after + 181_000));
  assert.equal(view.state, 'resting');
  assert.equal(view.reason, '3 of 3 trial codes unused');
});
