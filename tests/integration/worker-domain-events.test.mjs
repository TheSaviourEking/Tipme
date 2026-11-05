import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleDomainEvent } from '../../apps/worker/dist/handlers/domain-events.js';
import { randomUUID } from 'node:crypto';
import {
  createPaymentIntent,
  createQuote,
  mailSealing,
  recordProviderEvent,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
import { REDIS_URL, Redis, startStack } from './helpers.mjs';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';

// The worker's handling of an outbox event, against a real database.

const ADA_PROFILE = '00000000-0000-7000-8000-00000000ada0';
let database;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
});
after(() => database?.close());

const logger = { info() {}, warn() {}, error() {} };

test('fix: a failing withdrawal email never stops staff seeing the failed withdrawal', async () => {
  const q = (sql, params) => database.pool.query(sql, params);
  const payoutId = '00000000-0000-7000-8000-00000000b001';
  await q(
    `INSERT INTO payouts (id, profile_id, amount_minor, currency, status, idempotency_key, request_fingerprint)
     VALUES ($1, $2, 250000, 'NGN', 'FAILED', $3, $3)`,
    [payoutId, ADA_PROFILE, `key-${payoutId}`],
  );
  // An address that can't be queued makes the email step throw.
  await q(
    `UPDATE users SET email = 'not an address', email_verified_at = now()
      WHERE id = (SELECT user_id FROM profiles WHERE id = $1)`,
    [ADA_PROFILE],
  );
  await assert.rejects(
    handleDomainEvent(
      'payout.failed',
      { payoutId, profileId: ADA_PROFILE },
      {
        db: database.db,
        logger,
        dedupeKey: `payout.failed.${payoutId}`,
        sealing: mailSealing(Buffer.alloc(32, 7)),
        pretendPayment: true,
      },
    ),
  );
  const { rows } = await q(
    `SELECT kind FROM issues WHERE kind = 'payout_failed'`,
  );
  assert.equal(
    rows.length,
    1,
    'the issue is open even though the email failed',
  );
});

test('after notifyTipSucceeded commits, notifications.changed is published for the profile', async (t) => {
  // The test above breaks ada's email on purpose; start from a clean seed.
  await database.reset();
  await seedDemoProfiles(database.db);
  const stack = await startStack({ databaseUrl: database.url });
  t.after(() => stack.stop());
  const subscriber = new Redis(REDIS_URL);
  t.after(() => subscriber.quit());
  const arrivals = [];
  subscriber.on('message', (_channel, raw) => {
    const message = JSON.parse(raw);
    if (message.type !== 'notifications.changed') return;
    // The notification row must already be readable when the signal arrives.
    arrivals.push(
      database.pool
        .query(
          `SELECT count(*)::int AS n FROM notifications
            WHERE user_id = (SELECT user_id FROM profiles WHERE id = $1) AND kind = 'tip'`,
          [message.to.profile],
        )
        .then(({ rows }) => ({ message, notifications: rows[0].n })),
    );
  });
  await subscriber.subscribe(`${stack.prefix}:live:v1`);
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  const { attemptId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    attemptId,
    providerReference: `ref-${attemptId}`,
    amountMinor: 200000n,
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: {},
  });
  const deadline = Date.now() + 10_000;
  while (arrivals.length === 0 && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const [first] = await Promise.all(arrivals);
  assert.ok(first, 'notifications.changed was published');
  assert.deepEqual(first.message.to, { profile: ADA_PROFILE });
  assert.ok(
    first.notifications >= 1,
    'published after the notification committed',
  );
});
