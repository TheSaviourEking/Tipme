import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  markAttemptInitiated,
  recordPayoutOutcome,
  recordProviderEvent,
  reconcilePayouts,
  requestWithdrawal,
  resumeHeldPayout,
  openIssue,
  setWithdrawalsPaused,
  startPayout,
  withdrawalQuote,
  withdrawalsSwitchState,
  DEMO_PROFILES,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

const TOBI = DEMO_PROFILES[1].id;
const STAFF = '00000000-0000-7000-8000-00000000f00d';
const REASON = 'A wrong payout amount: stopping while we look.';

function provider() {
  const calls = { creates: 0 };
  return {
    calls,
    name: 'mock',
    capabilities: { connectedAccounts: false },
    payoutCapability: async () => ({ status: 'active', requirementsDue: [] }),
    payoutBalance: async () => ({ availableMinor: 100_000_000n }),
    quotePayoutFee: async () => ({ feeMinor: 5000n, exact: false }),
    coverPayoutFee: async () => ({ transferRef: 'transfer' }),
    initiatePayout: async () => {
      calls.creates += 1;
      return {
        providerReference: `mock_out_${randomUUID()}`,
        status: 'pending',
      };
    },
    findPayoutByReference: async () => null,
    fetchPayoutStatus: async () => ({ status: 'not_found' }),
  };
}

async function setup(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const quote = await createQuote(db, {
    handle: 'tobi',
    tipMinor: 2000000n,
    currency: 'NGN',
  });
  const intent = await createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `mock_pay_${randomUUID()}`;
  await markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await recordProviderEvent(db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: 2000000n,
    currency: 'NGN',
    providerFeeMinor: 3000n,
    signatureVerified: true,
    payload: {},
  });
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const withdraw = async () =>
    (
      await requestWithdrawal(db, {
        profileId: TOBI,
        amountMinor: 100000n,
        idempotencyKey: randomUUID(),
        provider: provider(),
      })
    ).payoutId;
  const pause = (paused) =>
    setWithdrawalsPaused(db, { paused, staffUserId: STAFF, reason: REASON });
  const startJobs = async (payoutId) =>
    q(
      `SELECT id FROM outbox_events WHERE event_type = 'payouts.start' AND aggregate_id = $1`,
      [payoutId],
    );
  return { ...database, db, q, withdraw, pause, startJobs };
}

test('nobody has ever switched it: withdrawals are on', async (t) => {
  const s = await setup(t);
  assert.deepEqual(await withdrawalsSwitchState(s.db), {
    paused: false,
    changedAt: null,
  });
});

test('while off a request is refused with its own code, and the quote says so before any amount', async (t) => {
  const s = await setup(t);
  await s.pause(true);
  await assert.rejects(s.withdraw(), { code: 'WITHDRAWALS_SWITCHED_OFF' });
  assert.deepEqual(
    await withdrawalQuote(s.db, { profileId: TOBI, provider: provider() }),
    { state: 'paused', reason: 'switched_off' },
  );
  assert.equal((await s.q('SELECT id FROM payouts')).length, 0);
  await s.pause(false);
  assert.ok(await s.withdraw());
});

test('a retry of a request made before the switch still gets its payout', async (t) => {
  const s = await setup(t);
  const key = randomUUID();
  const ask = () =>
    requestWithdrawal(s.db, {
      profileId: TOBI,
      amountMinor: 100000n,
      idempotencyKey: key,
      provider: provider(),
    });
  const first = await ask();
  await s.pause(true);
  const again = await ask();
  assert.equal(again.payoutId, first.payoutId);
  assert.equal(again.replayed, true);
});

test('a queued payout is not started while off, stays reserved with no failure, and is queued again when on', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.pause(true);
  const fake = provider();
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'switched_off',
  );
  assert.equal(fake.calls.creates, 0);
  const [row] = await s.q(
    'SELECT status, start_step, start_uncertain_at FROM payouts WHERE id = $1',
    [payoutId],
  );
  assert.deepEqual(row, {
    status: 'REQUESTED',
    start_step: null,
    start_uncertain_at: null,
  });
  assert.equal(
    (
      await s.q(`SELECT id FROM issues WHERE subject->>'payoutId' = $1`, [
        payoutId,
      ])
    ).length,
    0,
  );
  const before = (await s.startJobs(payoutId)).length;
  await s.pause(false);
  assert.equal((await s.startJobs(payoutId)).length, before + 1);
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'started',
  );
  assert.equal(fake.calls.creates, 1);
});

test('switching on does not requeue a payout staff must decide on, or one already sent', async (t) => {
  const s = await setup(t);
  const held = await s.withdraw();
  await openIssue(s.db, {
    dedupeKey: `payout_held.${held}`,
    kind: 'payout_held',
    subject: { payoutId: held },
    now: new Date(),
  });
  const sent = await s.withdraw();
  await startPayout(s.db, { payoutId: sent, provider: provider() });
  const heldBefore = (await s.startJobs(held)).length;
  const sentBefore = (await s.startJobs(sent)).length;
  await s.pause(true);
  await s.pause(false);
  assert.equal((await s.startJobs(held)).length, heldBefore);
  assert.equal((await s.startJobs(sent)).length, sentBefore);
});

test('a payout already sent still settles while off', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const fake = provider();
  await startPayout(s.db, { payoutId, provider: fake });
  const [{ provider_reference: reference }] = await s.q(
    'SELECT provider_reference FROM payouts WHERE id = $1',
    [payoutId],
  );
  await s.pause(true);
  await recordPayoutOutcome(s.db, {
    payoutId,
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    providerReference: reference,
    outcome: 'paid',
    signatureVerified: true,
    payload: {},
  });
  const [row] = await s.q('SELECT status FROM payouts WHERE id = $1', [
    payoutId,
  ]);
  assert.equal(row.status, 'PAID');
});

test('a start whose outcome is unknown is still only read while off: reads go on, nothing is sent', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.q(
    'UPDATE payouts SET start_uncertain_at = now(), start_step = $2 WHERE id = $1',
    [payoutId, 'payout'],
  );
  await s.pause(true);
  const fake = provider();
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'uncertain',
  );
  assert.equal(fake.calls.creates, 0);
});

test('if the switch cannot be read nothing starts and nothing is requested', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.q('ALTER TABLE withdrawals_switch RENAME TO withdrawals_switch_gone');
  try {
    const fake = provider();
    await assert.rejects(startPayout(s.db, { payoutId, provider: fake }));
    assert.equal(fake.calls.creates, 0);
    await assert.rejects(s.withdraw());
    assert.deepEqual(
      await withdrawalQuote(s.db, { profileId: TOBI, provider: provider() }),
      { state: 'paused', reason: 'switched_off' },
    );
  } finally {
    await s.q(
      'ALTER TABLE withdrawals_switch_gone RENAME TO withdrawals_switch',
    );
  }
});

test('reconciliation opens no "unresolved" issue for payouts waiting on the switch, or just released', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.q(
    `UPDATE payouts SET created_at = now() - interval '3 hours' WHERE id = $1`,
    [payoutId],
  );
  const issues = () =>
    s.q(`SELECT kind FROM issues WHERE subject->>'payoutId' = $1`, [payoutId]);
  const reconcile = (now = new Date()) =>
    reconcilePayouts({
      db: s.db,
      provider: () => provider(),
      now,
      minAgeMs: 0,
    });
  await s.pause(true);
  await reconcile();
  assert.deepEqual(await issues(), []);
  await s.pause(false);
  await reconcile();
  assert.deepEqual(await issues(), []);
  // Once the wait has passed since the switch, a payout that never started is raised as before.
  await reconcile(new Date(Date.now() + 2 * 60 * 60 * 1000));
  assert.deepEqual(await issues(), [{ kind: 'payout_unresolved' }]);
});

test('staff cannot resume a held payout while withdrawals are off', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const { id: issueId } = await openIssue(s.db, {
    dedupeKey: `payout_held.${payoutId}`,
    kind: 'payout_held',
    subject: { payoutId },
    now: new Date(),
  });
  await s.pause(true);
  const result = await resumeHeldPayout(s.db, {
    issueId,
    reason: REASON,
    staffUserId: STAFF,
    provider: () => provider(),
  });
  assert.equal(result.outcome, 'not_offered');
});

test('each change is audited with its reason and raises one alert; setting the same state changes nothing', async (t) => {
  const s = await setup(t);
  const audit = (action) =>
    s.q(
      'SELECT reason, staff_user_id, permission FROM audit_events WHERE action = $1',
      [action],
    );
  const alerts = () =>
    s.q(
      `SELECT payload FROM outbox_events WHERE event_type = 'withdrawals.switch_changed' ORDER BY created_at`,
    );
  assert.equal((await s.pause(true)).changed, true);
  assert.equal((await s.pause(true)).changed, false);
  const paused = await audit('withdrawals.switched_off');
  assert.equal(paused.length, 1);
  assert.equal(paused[0].reason, REASON);
  assert.equal(paused[0].staff_user_id, STAFF);
  assert.equal(paused[0].permission, 'payouts.resolve');
  await s.pause(false);
  assert.equal((await audit('withdrawals.switched_on')).length, 1);
  const raised = await alerts();
  assert.deepEqual(
    raised.map((row) => row.payload.state),
    ['off', 'on'],
  );
  // The alert route is a chat room: a written reason stays in the audit log.
  assert.equal(JSON.stringify(raised).includes(REASON), false);
  const state = await withdrawalsSwitchState(s.db);
  assert.equal(state.paused, false);
  assert.ok(state.changedAt instanceof Date);
});
