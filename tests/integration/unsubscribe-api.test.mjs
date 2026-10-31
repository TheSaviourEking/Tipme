import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import {
  getNotificationPrefs,
  mailSealing,
  seedDemoProfiles,
  unsubscribeToken,
} from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { MAIL_SEAL_KEY, startStack } from './helpers.mjs';

// One-click unsubscribe (RFC 8058) over real HTTP: mail clients post a form, with no cookie.

const TOBI_USER = '00000000-0000-7000-8000-000000007b11';
let stack;
let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  stack = await startStack({ databaseUrl: database.url });
});
after(async () => {
  await stack?.stop();
  await database?.close();
});

const tokenFor = (type) =>
  unsubscribeToken(mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64')), {
    userId: TOBI_USER,
    type,
  });

test('one-click POST turns off that email type', async () => {
  const response = await fetch(
    `${stack.api}/v1/mail/unsubscribe?t=${tokenFor('weekly_report')}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    },
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.type, 'weekly_report');
  const prefs = await getNotificationPrefs(database.db, TOBI_USER);
  assert.equal(prefs.weeklyReports, false);
});

test('a forged token is refused', async () => {
  const response = await fetch(
    `${stack.api}/v1/mail/unsubscribe?t=bm90LWEtdG9rZW4.${'0'.repeat(32)}`,
    { method: 'POST' },
  );
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'UNSUBSCRIBE_INVALID');
});

test('opening the link only shows a page: link scanners turn nothing off', async () => {
  const token = tokenFor('milestone');
  const response = await fetch(`${stack.api}/v1/mail/unsubscribe?t=${token}`, {
    redirect: 'manual',
  });
  assert.equal(response.status, 303);
  assert.match(
    response.headers.get('location'),
    new RegExp(`/email/unsubscribed\\?t=${token.replace('.', '\\.')}$`),
  );
  const prefs = await getNotificationPrefs(database.db, TOBI_USER);
  assert.equal(prefs.milestones, true);
});
