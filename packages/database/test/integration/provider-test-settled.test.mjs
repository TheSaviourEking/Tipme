import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MailRejectedError, MailTemporaryError } from '@tipme/mail';
import {
  addressHmac,
  deliverDueMail,
  enqueueMail,
  mailSealing,
  startMailProviderTest,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Live providers screen (addendum §3.3): a provider-test email reaching a final delivery state (sent
// or failed for good) tells the worker, which signals the staff watching the Providers page.

const sealing = mailSealing(Buffer.alloc(32, 7));
const STAFF = '00000000-0000-7000-8000-000000007b11';
const T0 = new Date('2026-11-26T10:00:00Z');

/** The pretend provider, answering each send as the test says (by default, accepted). */
function provider(outcomes = []) {
  return {
    name: 'mock',
    capabilities: { marketing: false },
    async send() {
      const next = outcomes.shift() ?? { ok: true };
      if (next.rejected) throw new MailRejectedError(next.rejected);
      if (next.temporary) throw new MailTemporaryError(next.temporary);
      return { providerMessageId: 'mock-1' };
    },
    verifyWebhook: () => ({ ok: false, reason: 'signature' }),
    async status() {
      return { sandbox: null, detail: null };
    },
  };
}

async function setup(t, { outcomes, onProviderTestSettled } = {}) {
  const database = await useDatabase(t);
  await database.fresh();
  const calls = [];
  const deps = {
    db: database.db,
    sealing,
    providers: new Map([['mock', provider(outcomes)]]),
    activeProvider: async () => 'mock',
    overrideFor: async () => null,
    sender: { domain: 'mail.usetipme.xyz', name: 'TipMe' },
    webOrigin: 'http://localhost:3000',
    apiOrigin: 'http://localhost:4000',
    onProviderTestSettled:
      onProviderTestSettled ?? (() => void calls.push('settled')),
  };
  const status = async (type) =>
    (
      await database.pool.query(
        'SELECT status FROM mail_messages WHERE type = $1',
        [type],
      )
    ).rows[0]?.status;
  return {
    ...database,
    calls,
    status,
    deliver: (now = T0) => deliverDueMail(deps, { now, limit: 20 }),
  };
}

const startTest = (db) =>
  startMailProviderTest(db, sealing, {
    staffUserId: STAFF,
    provider: 'mock',
    to: 'staff@example.com',
    webOrigin: 'http://localhost:3000',
    reason: 'Checking the provider',
    now: T0,
  });

test('a provider test mail that fails calls onProviderTestSettled once', async (t) => {
  const s = await setup(t, { outcomes: [{ rejected: 'address_rejected' }] });
  await startTest(s.db);
  await s.deliver();
  assert.equal(await s.status('provider_test'), 'failed');
  assert.deepEqual(s.calls, ['settled']);
  // Nothing left to send: no second call.
  await s.deliver(new Date(T0.getTime() + 60_000));
  assert.deepEqual(s.calls, ['settled']);
});

test('a provider test mail that is sent calls it once, after the sent row is written', async (t) => {
  // What the row reads at the moment of each call: it runs after the write resolved.
  const seen = [];
  const s = await setup(t, {
    onProviderTestSettled: () => void seen.push(s.status('provider_test')),
  });
  await startTest(s.db);
  await s.deliver();
  assert.deepEqual(await Promise.all(seen), ['sent']);
});

test('a provider test to an address that does not exist (suppressed) is settled too', async (t) => {
  const s = await setup(t);
  await s.pool.query(
    `INSERT INTO mail_suppressions (address_hmac, reason) VALUES ($1, 'hard_bounce')`,
    [addressHmac(sealing, 'staff@example.com')],
  );
  await startTest(s.db);
  await s.deliver();
  assert.equal(await s.status('provider_test'), 'suppressed');
  assert.deepEqual(s.calls, ['settled']);
});

test('a provider test waiting for its retry is not settled yet', async (t) => {
  const s = await setup(t, { outcomes: [{ temporary: 'http_503' }] });
  await startTest(s.db);
  await s.deliver();
  assert.equal(await s.status('provider_test'), 'queued');
  assert.deepEqual(s.calls, []);
});

test('an ordinary mail never calls it', async (t) => {
  const s = await setup(t, { outcomes: [{ ok: true }, { rejected: 'nope' }] });
  for (const n of [1, 2])
    await enqueueMail(s.db, sealing, {
      type: 'tip_received',
      to: `tobi${n}@example.com`,
      data: {
        firstName: 'Tobi',
        netMinor: '180000',
        supporterLabel: 'Ada',
        pretendPayment: true,
      },
      dedupeKey: `tip_received.settled.${n}`,
      now: T0,
    });
  const result = await s.deliver();
  assert.equal(result.sent, 1);
  assert.equal(result.failed, 1);
  assert.deepEqual(s.calls, []);
});

test('a callback that throws changes nothing: the mail is recorded and the pass goes on', async (t) => {
  const s = await setup(t, {
    onProviderTestSettled: () => {
      throw new Error('publish broke');
    },
  });
  await startTest(s.db);
  const result = await s.deliver();
  assert.equal(result.sent, 1);
  assert.equal(await s.status('provider_test'), 'sent');
});
