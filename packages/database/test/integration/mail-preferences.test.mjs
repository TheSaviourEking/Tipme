import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMockMailProvider } from '@tipme/mail';
import {
  applyUnsubscribe,
  deliverDueMail,
  enqueueMail,
  getNotificationPrefs,
  mailGate,
  mailSealing,
  readUnsubscribeToken,
  setNotificationPrefs,
  unsubscribeToken,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const sealing = mailSealing(Buffer.alloc(32, 7));
const TOBI_USER = '00000000-0000-7000-8000-000000007b11';
const API = 'http://localhost:4000';

async function fresh(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const rows = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  return { ...database, rows };
}

const claimed = (type, category) => ({
  id: '00000000-0000-7000-8000-00000000c001',
  type,
  category,
  userId: TOBI_USER,
  to: 'tobi@example.com',
  data: {},
  pinnedProvider: null,
  expiresAt: null,
  attempts: 0,
  claimedAt: new Date(),
});

test('an unsubscribe token names its person and type, and a forged one is refused', () => {
  const token = unsubscribeToken(sealing, {
    userId: TOBI_USER,
    type: 'tip_received',
  });
  assert.deepEqual(readUnsubscribeToken(sealing, token), {
    userId: TOBI_USER,
    type: 'tip_received',
  });
  const [body] = token.split('.');
  assert.equal(
    readUnsubscribeToken(sealing, `${body}.${'0'.repeat(32)}`),
    null,
  );
  assert.equal(
    readUnsubscribeToken(mailSealing(Buffer.alloc(32, 8)), token),
    null,
  );
  assert.equal(readUnsubscribeToken(sealing, 'nonsense'), null);
  // Security mail can't be turned off, so it has no token to read.
  const security = unsubscribeToken(sealing, {
    userId: TOBI_USER,
    type: 'sign_in_code',
  });
  assert.equal(readUnsubscribeToken(sealing, security), null);
});

test('one-click unsubscribe turns off that email type', async (t) => {
  const { db } = await fresh(t);
  assert.equal(
    await applyUnsubscribe(db, { userId: TOBI_USER, type: 'tip_received' }),
    'done',
  );
  const prefs = await getNotificationPrefs(db, TOBI_USER);
  assert.equal(prefs.tipEmails, false);
  assert.equal(prefs.weeklyReports, true);
});

test('turning off engagement stops onboarding emails but not tip emails', async (t) => {
  const { db } = await fresh(t);
  const before = await getNotificationPrefs(db, TOBI_USER);
  assert.equal(before.guideEmails, true);
  await setNotificationPrefs(db, TOBI_USER, { ...before, guideEmails: false });
  const now = new Date();
  assert.equal(
    await mailGate(db, sealing, claimed('onboarding_day_1', 'engagement'), now),
    'skipped_preference',
  );
  assert.equal(
    await mailGate(db, sealing, claimed('tip_received', 'transactional'), now),
    'send',
  );
  // Types with their own switch follow it, not the guides switch.
  assert.equal(
    await mailGate(db, sealing, claimed('weekly_report', 'engagement'), now),
    'send',
  );
});

test('security and account mail carry no unsubscribe header; optional mail does', async (t) => {
  const { db } = await fresh(t);
  const sent = [];
  const provider = createMockMailProvider(async (mail) => {
    sent.push(mail);
  });
  await enqueueMail(db, sealing, {
    type: 'sign_in_code',
    to: 'tobi@example.com',
    userId: TOBI_USER,
    data: { code: '123456' },
    dedupeKey: 'sign_in_code.header',
  });
  await enqueueMail(db, sealing, {
    type: 'welcome',
    to: 'tobi@example.com',
    userId: TOBI_USER,
    data: {},
    dedupeKey: 'welcome.header',
  });
  await enqueueMail(db, sealing, {
    type: 'tip_received',
    to: 'tobi@example.com',
    userId: TOBI_USER,
    data: {
      firstName: 'Tobi',
      netMinor: '180000',
      supporterLabel: 'Ada',
      pretendPayment: true,
    },
    dedupeKey: 'tip_received.header',
  });
  await deliverDueMail(
    {
      db,
      sealing,
      providers: new Map([['mock', provider]]),
      activeProvider: async () => 'mock',
      overrideFor: async () => null,
      from: { address: 'hello@mail.usetipme.xyz', name: 'TipMe' },
      webOrigin: 'http://localhost:3000',
      apiOrigin: API,
    },
    { now: new Date() },
  );
  const bySubject = (part) => sent.find((m) => m.subject.includes(part));
  assert.deepEqual(bySubject('sign-in code').headers, {});
  assert.deepEqual(bySubject('Welcome').headers, {});
  const tip = bySubject('tip');
  assert.match(
    tip.headers['List-Unsubscribe'],
    /^<http:\/\/localhost:4000\/v1\/mail\/unsubscribe\?t=[\w.-]+>$/,
  );
  assert.equal(
    tip.headers['List-Unsubscribe-Post'],
    'List-Unsubscribe=One-Click',
  );
  assert.match(tip.text, /Email settings: http:\/\/localhost:4000\/v1\/mail/);
});
