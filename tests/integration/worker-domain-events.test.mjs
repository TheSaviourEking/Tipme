import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { handleDomainEvent } from '../../apps/worker/dist/handlers/domain-events.js';
import {
  mailSealing,
  seedDemoProfiles,
} from '../../packages/database/dist/index.js';
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
