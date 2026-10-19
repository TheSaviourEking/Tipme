import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  autoResolveIssues,
  createPaymentIntent,
  createQuote,
  issueById,
  listAudit,
  listIssues,
  openIssueFromEvent,
  recordProviderEvent,
  recordUnmatchedEvent,
  runIssueDetectors,
} from '../../dist/index.js';
import { ADA, useDatabase } from './helpers.mjs';

const MIN = 60_000;
const event = (attemptId, overrides = {}) => ({
  provider: 'mock',
  providerEventId: randomUUID(),
  eventType: 'payment.succeeded',
  attemptId,
  providerReference: `ref-${attemptId}`,
  amountMinor: 100000n,
  currency: 'NGN',
  providerFeeMinor: 1500n,
  signatureVerified: true,
  payload: { kind: 'test' },
  ...overrides,
});

test('issues', async (t) => {
  const database = await useDatabase(t);
  const q = (sql, params) =>
    database.pool.query(sql, params).then((result) => result.rows);
  const newTip = async () => {
    const { quoteId } = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 100000n,
      currency: 'NGN',
    });
    return createPaymentIntent(database.db, {
      quoteId,
      idempotencyKey: randomUUID(),
      payerDisplayLabel: 'Zainab Secretname',
      message: 'Private words xyzzy',
    });
  };

  await t.test(
    'an outbox alert opens one issue; delivering it again changes nothing',
    async () => {
      await database.fresh();
      const { tipId, attemptId } = await newTip();
      await recordProviderEvent(
        database.db,
        event(attemptId, { amountMinor: 1n }),
      );
      const [alert] = await q(
        `SELECT event_type, dedupe_key, payload FROM outbox_events WHERE event_type = 'payment.mismatch'`,
      );
      const input = {
        eventType: alert.event_type,
        dedupeKey: alert.dedupe_key,
        payload: alert.payload,
      };
      assert.equal(await openIssueFromEvent(database.db, input), 'opened');
      assert.equal(await openIssueFromEvent(database.db, input), 'duplicate');
      const issues = await listIssues(database.db, { limit: 10 });
      assert.equal(issues.length, 1);
      const [issue] = issues;
      assert.equal(issue.kind, 'payment_mismatch');
      assert.equal(issue.severity, 'money');
      assert.equal(issue.status, 'open');
      assert.equal(issue.subject.tipId, tipId);
      assert.equal(issue.subject.attemptId, attemptId);
      assert.equal(issue.subject.profileId, ADA);
      assert.match(issue.summary, /@ada/);
      assert.deepEqual(await issueById(database.db, issue.id), issue);
      const text = JSON.stringify(issues);
      assert.equal(text.includes('xyzzy'), false, 'no message text');
      assert.equal(text.includes('Secretname'), false, 'no supporter name');
    },
  );

  await t.test(
    'every alert kind maps to its kind and severity; tip events are not issues',
    async () => {
      await database.fresh();
      const cases = [
        ['payment.conflict', 'payment_conflict', 'money'],
        ['payment.unresolved', 'payment_unresolved', 'money'],
        ['payout.failed', 'payout_failed', 'money'],
        ['payout.conflict', 'payout_conflict', 'money'],
        ['provider_event.conflict', 'provider_event_conflict', 'money'],
      ];
      for (const [eventType, kind, severity] of cases) {
        assert.equal(
          await openIssueFromEvent(database.db, {
            eventType,
            dedupeKey: `${eventType}.${randomUUID()}`,
            payload: {},
          }),
          'opened',
        );
        const [issue] = await listIssues(database.db, { kind, limit: 1 });
        assert.equal(issue.severity, severity, kind);
      }
      assert.equal(
        await openIssueFromEvent(database.db, {
          eventType: 'tip.succeeded',
          dedupeKey: 'tip.succeeded.x',
          payload: {},
        }),
        'ignored',
      );
    },
  );

  await t.test(
    'a tip confirming for 31 minutes is an issue; it resolves itself once paid; a new stuck tip is a new issue',
    async () => {
      await database.fresh();
      const { tipId, attemptId } = await newTip();
      await recordProviderEvent(
        database.db,
        event(attemptId, { eventType: 'payment.pending' }),
      );
      assert.equal(
        (await q('SELECT status FROM tips WHERE id = $1', [tipId]))[0].status,
        'PENDING_VERIFICATION',
      );
      const soon = new Date(Date.now() + 29 * MIN);
      assert.deepEqual(await runIssueDetectors(database.db, soon), {
        opened: 0,
      });
      const later = new Date(Date.now() + 31 * MIN);
      assert.deepEqual(await runIssueDetectors(database.db, later), {
        opened: 1,
      });
      assert.deepEqual(await runIssueDetectors(database.db, later), {
        opened: 0,
      });
      const [stuck] = await listIssues(database.db, {
        kind: 'stuck_tip',
        limit: 5,
      });
      assert.equal(stuck.severity, 'info');
      assert.equal(stuck.subject.tipId, tipId);
      assert.match(stuck.summary, /@ada/);

      assert.deepEqual(await autoResolveIssues(database.db, later), {
        resolved: 0,
      });
      await recordProviderEvent(database.db, event(attemptId));
      assert.deepEqual(await autoResolveIssues(database.db, later), {
        resolved: 1,
      });
      const resolved = await issueById(database.db, stuck.id);
      assert.equal(resolved.status, 'resolved');
      assert.equal(resolved.resolvedBy, 'system');
      const audit = await listAudit(database.db, { limit: 5 });
      assert.ok(
        audit.some(
          (e) =>
            e.action === 'issue.auto_resolved' &&
            e.subjectId === stuck.id &&
            e.staffUserId === null,
        ),
      );

      const second = await newTip();
      await recordProviderEvent(
        database.db,
        event(second.attemptId, { eventType: 'payment.pending' }),
      );
      const muchLater = new Date(Date.now() + 40 * MIN);
      assert.deepEqual(await runIssueDetectors(database.db, muchLater), {
        opened: 1,
      });
      assert.equal(
        (await listIssues(database.db, { status: 'open', limit: 10 })).length,
        1,
      );
    },
  );

  await t.test(
    'unmatched provider events and pending recoveries are issues; a cancelled recovery resolves itself',
    async () => {
      await database.fresh();
      await recordUnmatchedEvent(database.db, {
        provider: 'mock',
        providerEventId: 'evt-unmatched-1',
        eventType: 'payment.succeeded',
        payload: { reference: 'nobody' },
        reason: 'unknown_attempt',
      });
      const [ada] = await q('SELECT user_id FROM profiles WHERE id = $1', [
        ADA,
      ]);
      let userId = ada.user_id;
      if (!userId) {
        userId = randomUUID();
        await q(
          `INSERT INTO users (id, phone_e164) VALUES ($1, '+2348037770001')`,
          [userId],
        );
      }
      const [recovery] = await q(
        `INSERT INTO phone_recoveries (id, user_id, new_phone_e164, effective_at)
         VALUES (gen_random_uuid(), $1, '+2348037770002', now() + interval '24 hours') RETURNING id`,
        [userId],
      );
      const now = new Date();
      assert.deepEqual(await runIssueDetectors(database.db, now), {
        opened: 2,
      });
      const [unmatched] = await listIssues(database.db, {
        kind: 'unmatched_event',
        limit: 1,
      });
      assert.equal(unmatched.severity, 'info');
      const [pending] = await listIssues(database.db, {
        kind: 'pending_recovery',
        limit: 1,
      });
      assert.equal(pending.severity, 'account');
      assert.equal(pending.subject.recoveryId, recovery.id);
      assert.equal(pending.summary.includes('7770002'), false, 'no number');
      await q(
        'UPDATE phone_recoveries SET cancelled_at = now() WHERE id = $1',
        [recovery.id],
      );
      assert.deepEqual(await autoResolveIssues(database.db, now), {
        resolved: 1,
      });
      assert.equal(
        (await issueById(database.db, pending.id)).status,
        'resolved',
      );
      assert.equal(
        (await issueById(database.db, unmatched.id)).status,
        'open',
        'unmatched events need a person',
      );
    },
  );

  await t.test(
    'lists filter by status and severity, newest first',
    async () => {
      await database.fresh();
      for (const eventType of ['payout.failed', 'payment.conflict'])
        await openIssueFromEvent(database.db, {
          eventType,
          dedupeKey: `${eventType}.${randomUUID()}`,
          payload: {},
        });
      const all = await listIssues(database.db, { limit: 10 });
      assert.deepEqual(
        all.map((i) => i.kind),
        ['payment_conflict', 'payout_failed'],
      );
      assert.equal(
        (await listIssues(database.db, { severity: 'info', limit: 10 })).length,
        0,
      );
      const page = await listIssues(database.db, { limit: 1 });
      const next = await listIssues(database.db, {
        limit: 1,
        cursor: page[0].id,
      });
      assert.equal(next[0].kind, 'payout_failed');
      await q(
        `INSERT INTO issue_notes (id, issue_id, staff_user_id, text) VALUES (gen_random_uuid(), $1, NULL, 'note')`,
        [all[0].id],
      );
      await assert.rejects(q('DELETE FROM issue_notes'));
      await assert.rejects(q(`UPDATE issue_notes SET text = 'edited'`));
    },
  );
});
