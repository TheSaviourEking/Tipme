import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  healthMetrics,
  openIssueFromEvent,
  recordClientEvent,
  recordProviderEvent,
  recordServerEvent,
  visibilityMetrics,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

test('admin metrics', async (t) => {
  const database = await useDatabase(t);
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  const WEEK = "interval '7 days'";

  /** A tip to Ada paid (or declined) through verified provider events. */
  const tip = async (outcome = 'succeeded') => {
    const quote = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
    });
    const { tipId, attemptId } = await createPaymentIntent(database.db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const [{ payer_total_minor: total }] = await q(
      'SELECT payer_total_minor FROM tip_quotes WHERE id = $1',
      [quote.quoteId],
    );
    await recordProviderEvent(database.db, {
      provider: 'mock',
      providerEventId: randomUUID(),
      eventType:
        outcome === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
      attemptId,
      providerReference: `ref-${attemptId}`,
      amountMinor: BigInt(total),
      currency: 'NGN',
      providerFeeMinor: 1500n,
      signatureVerified: true,
      payload: { kind: 'test' },
    });
    return tipId;
  };
  const toLastWeek = (tipId) =>
    q(
      `UPDATE tips SET created_at = created_at - ${WEEK}, completed_at = completed_at - ${WEEK} WHERE id = $1`,
      [tipId],
    );

  await t.test(
    'health compares this week with last week, from the money tables',
    async () => {
      await database.fresh();
      for (const id of [await tip(), await tip()]) await toLastWeek(id);
      for (let i = 0; i < 3; i++) await tip();
      await q(
        'INSERT INTO fee_free_credits (profile_id, remaining) VALUES ($1, 1)',
        [ADA],
      );
      const feeFree = await tip();
      await tip('failed');
      await openIssueFromEvent(database.db, {
        eventType: 'payment.mismatch',
        dedupeKey: `payment.mismatch.${randomUUID()}`,
        payload: {},
      });

      const [{ waived }] = await q(
        `SELECT q.waived_platform_fee_minor::text AS waived FROM tips t
         JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
        WHERE t.id = $1`,
        [feeFree],
      );
      assert.ok(BigInt(waived) > 0n, 'the fee-free tip waived a fee');
      const [{ gross, fees }] = await q(
        `SELECT sum(t.gross_minor)::text AS gross, sum(q.platform_fee_minor)::text AS fees
         FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
        WHERE t.status = 'SUCCEEDED' AND t.completed_at > now() - interval '1 day'`,
      );

      const health = await healthMetrics(database.db, { now: new Date() });
      assert.deepEqual(health.money.tipCount, { thisWeek: 4, lastWeek: 2 });
      assert.equal(health.money.grossMinor.thisWeek, gross);
      assert.equal(health.money.platformFeeMinor.thisWeek, fees);
      assert.equal(health.money.rewardCostMinor.thisWeek, waived);
      assert.equal(health.money.rewardCostMinor.lastWeek, '0');
      assert.equal(health.reliability.declinedRate.thisWeek, 0.2);
      assert.equal(health.reliability.declinedRate.lastWeek, 0);
      assert.equal(health.reliability.openIssues.money, 1);
      assert.ok(health.reliability.medianConfirmSeconds.thisWeek >= 0);
      assert.deepEqual(health.recipients.recipientsTipped, {
        thisWeek: 1,
        lastWeek: 1,
      });
      assert.equal(health.recipients.recipientsReturning, 1);
    },
  );

  await t.test(
    'the funnel counts visits, amounts chosen, payments started and tips completed this week',
    async () => {
      await database.fresh();
      const now = new Date();
      const a = randomUUID();
      const b = randomUUID();
      const record = (event) =>
        recordClientEvent(database.db, { event, device: 'mobile', now });
      await record({
        name: 'profile_viewed',
        flowId: a,
        channel: 'qr',
        handle: 'ada',
      });
      await record({
        name: 'profile_viewed',
        flowId: a,
        channel: 'qr',
        handle: 'ada',
      });
      await record({
        name: 'profile_viewed',
        flowId: b,
        channel: 'instagram',
        handle: 'ada',
        returning: true,
      });
      await record({ name: 'amount_selected', flowId: a, handle: 'ada' });
      await record({ name: 'amount_selected', flowId: a, handle: 'ada' });
      await record({ name: 'payment_started', flowId: a, handle: 'ada' });
      await record({ name: 'qr_downloaded', flowId: randomUUID() });
      await recordServerEvent(database.db, {
        name: 'tip_completed',
        dedupeKey: `tip_completed.${randomUUID()}`,
        profileId: ADA,
      });
      const health = await healthMetrics(database.db, { now });
      assert.deepEqual(health.funnel, {
        visits: 2,
        amountSelected: 1,
        paymentStarted: 1,
        tipsCompleted: 1,
      });

      const visibility = await visibilityMetrics(database.db, {
        now,
        days: 28,
      });
      assert.equal(visibility.visits, 2);
      assert.equal(visibility.returningVisits, 1);
      assert.equal(
        visibility.byChannel.reduce((sum, c) => sum + c.visits, 0),
        visibility.visits,
        'channels add up to visits',
      );
      assert.deepEqual(
        Object.fromEntries(
          visibility.byChannel.map((c) => [c.channel, c.visits]),
        ),
        { qr: 1, instagram: 1 },
      );
      assert.deepEqual(visibility.topPages, [{ handle: 'ada', visits: 2 }]);
      assert.equal(visibility.sharing.qr_downloaded, 1);
      assert.equal(visibility.visitsPerDay.length, 28);
      assert.equal(
        visibility.visitsPerDay.reduce((sum, d) => sum + d.visits, 0),
        2,
      );
    },
  );

  await t.test(
    'celebration tips (added to a shared moment) are counted',
    async () => {
      await database.fresh();
      const tipId = await tip();
      await q(
        `UPDATE tips SET celebration_moment_id = gen_random_uuid() WHERE id = $1`,
        [tipId],
      );
      const visibility = await visibilityMetrics(database.db, {
        now: new Date(),
        days: 28,
      });
      assert.equal(visibility.celebrationTips, 1);
    },
  );
});
