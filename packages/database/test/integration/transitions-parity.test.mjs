import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  ATTEMPT_STATUSES,
  ATTEMPT_TRANSITIONS,
  PAYOUT_STATUSES,
  PAYOUT_TRANSITIONS,
  TIP_STATUSES,
  TIP_TRANSITIONS,
  canTransition,
} from '@tipme/domain';
import {
  createPaymentIntent,
  createPayout,
  createQuote,
  recordProviderEvent,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

// The database must allow exactly the transitions the domain allows, even for direct UPDATEs.
test('database status rules match the domain transition tables', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const { quoteId } = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const { tipId, attemptId } = await createPaymentIntent(database.db, {
    quoteId,
    idempotencyKey: randomUUID(),
  });
  await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    attemptId,
    providerReference: 'r',
    amountMinor: 100000n,
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: {},
  });
  const { payoutId } = await createPayout(database.db, {
    profileId: ADA,
    tipIds: [tipId],
    idempotencyKey: randomUUID(),
  });

  // Released in `finally` below: an after-hook would run after the pool's close() and hang it.
  const client = await database.pool.connect();
  const allowedInDb = async (table, id, from, to) => {
    await client.query('BEGIN');
    try {
      // Place the row in `from` with triggers bypassed (no table lock), then try `to` normally.
      await client.query(`SET LOCAL session_replication_role = replica`);
      await client.query(`UPDATE ${table} SET status = $1 WHERE id = $2`, [
        from,
        id,
      ]);
      await client.query(`SET LOCAL session_replication_role = origin`);
      await client.query(`UPDATE ${table} SET status = $1 WHERE id = $2`, [
        to,
        id,
      ]);
      return true;
    } catch {
      return false;
    } finally {
      await client.query('ROLLBACK');
    }
  };
  try {
    for (const [table, id, statuses, rules] of [
      ['tips', tipId, TIP_STATUSES, TIP_TRANSITIONS],
      ['payment_attempts', attemptId, ATTEMPT_STATUSES, ATTEMPT_TRANSITIONS],
      ['payouts', payoutId, PAYOUT_STATUSES, PAYOUT_TRANSITIONS],
    ]) {
      for (const from of statuses) {
        for (const to of statuses) {
          if (from === to) continue;
          assert.equal(
            await allowedInDb(table, id, from, to),
            canTransition(rules, from, to),
            `${table}: ${from} -> ${to}`,
          );
        }
      }
    }
  } finally {
    client.release();
  }
});
