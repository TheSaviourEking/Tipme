import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  freezeWithdrawals,
  markAttemptInitiated,
  markPayoutFailedAbsent,
  recordPayoutOutcome,
  recordProviderEvent,
  reconcilePayouts,
  requestWithdrawal,
  resolveIssue,
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

// A queued withdrawal that a hold has touched is a person's to decide, whatever became of the hold.
const secure = (s, issueId) =>
  resolveIssue(s.db, {
    issueId,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'account_secured',
    bankAndSignInChecked: true,
  });
const freeze = (s) =>
  freezeWithdrawals(s.db, {
    profileId: TOBI,
    staffUserId: STAFF,
    reason: REASON,
  });
const heldIssues = (s, payoutId) =>
  s.q(
    `SELECT id FROM issues WHERE status = 'open' AND kind = 'payout_held' AND subject->>'payoutId' = $1`,
    [payoutId],
  );
const payoutStatus = async (s, payoutId) =>
  (await s.q('SELECT status FROM payouts WHERE id = $1', [payoutId]))[0].status;
/** A hold written straight to the table, so no code that places a hold has raised anything. */
const rawHold = async (s, { released, reason = 'reversal' }) => {
  const { id: issueId } = await openIssue(s.db, {
    dedupeKey: `raw_hold.${randomUUID()}`,
    kind: 'payment_reversed',
    subject: { profileId: TOBI },
    now: new Date(),
  });
  await s.q(
    `INSERT INTO withdrawal_holds (id, profile_id, reason, issue_id, released_at)
     VALUES ($1, $2, $3, $4, ${released ? 'now()' : 'NULL'})`,
    [randomUUID(), TOBI, reason, issueId],
  );
};

test('off, a thief queues, staff freeze and release, on: never sent, and a person is asked', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.pause(true);
  const fake = provider();
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'switched_off',
  );
  const { issueId } = await freeze(s);
  // At once, not when it next runs: nothing would run while withdrawals are off.
  assert.equal((await heldIssues(s, payoutId)).length, 1);
  await secure(s, issueId);
  const before = (await s.startJobs(payoutId)).length;
  await s.pause(false);
  assert.equal((await s.startJobs(payoutId)).length, before);
  // Even a job still out there, redelivered.
  assert.equal(await startPayout(s.db, { payoutId, provider: fake }), 'held');
  assert.equal(fake.calls.creates, 0);
  assert.equal((await heldIssues(s, payoutId)).length, 1);
  assert.equal(await payoutStatus(s, payoutId), 'REQUESTED');
});

test('the job refuses on a released hold alone, and opens the issue, however the hold came to be', async (t) => {
  for (const reason of ['reversal', 'in_debt', 'account_takeover']) {
    const s = await setup(t);
    const payoutId = await s.withdraw();
    await rawHold(s, { released: true, reason });
    assert.equal((await heldIssues(s, payoutId)).length, 0);
    const fake = provider();
    assert.equal(await startPayout(s.db, { payoutId, provider: fake }), 'held');
    assert.equal(fake.calls.creates, 0);
    assert.equal((await heldIssues(s, payoutId)).length, 1, reason);
  }
});

test('switching on with a hold no issue knows about: its job opens the issue and sends nothing', async (t) => {
  for (const released of [true, false]) {
    const s = await setup(t);
    const payoutId = await s.withdraw();
    await s.pause(true);
    await rawHold(s, { released });
    const fake = provider();
    await s.pause(false);
    assert.equal(await startPayout(s.db, { payoutId, provider: fake }), 'held');
    assert.equal(fake.calls.creates, 0);
    assert.equal((await heldIssues(s, payoutId)).length, 1);
  }
});

test('the hold is asked before the switch: a held job says so while off, and raises its issue', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.pause(true);
  await rawHold(s, { released: false });
  assert.equal(
    await startPayout(s.db, { payoutId, provider: provider() }),
    'held',
  );
  assert.equal((await heldIssues(s, payoutId)).length, 1);
});

test('a hold landing opens an issue for each unstarted payout, and not for one already attempted', async (t) => {
  const s = await setup(t);
  const first = await s.withdraw();
  const second = await s.withdraw();
  const sent = await s.withdraw();
  await startPayout(s.db, { payoutId: sent, provider: provider() });
  const attempted = await s.withdraw();
  await s.q(
    'UPDATE payouts SET start_uncertain_at = now(), start_step = $2 WHERE id = $1',
    [attempted, 'payout'],
  );
  const { issueId } = await freeze(s);
  assert.equal((await heldIssues(s, first)).length, 1);
  assert.equal((await heldIssues(s, second)).length, 1);
  assert.equal((await heldIssues(s, sent)).length, 0);
  assert.equal((await heldIssues(s, attempted)).length, 0);
  // They wait for the hold; they don't keep it in place.
  await secure(s, issueId);
  assert.equal(
    (
      await s.q(
        'SELECT 1 FROM withdrawal_holds WHERE profile_id = $1 AND released_at IS NULL',
        [TOBI],
      )
    ).length,
    0,
  );
});

test('the release notice\'s "mark it failed" is there, before the switch is back on, and returns the money', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.pause(true);
  await startPayout(s.db, { payoutId, provider: provider() });
  const { issueId } = await freeze(s);
  await secure(s, issueId);
  const [{ id: heldIssue }] = await heldIssues(s, payoutId);
  const result = await markPayoutFailedAbsent(s.db, {
    issueId: heldIssue,
    reason: REASON,
    staffUserId: STAFF,
    dashboardVerified: true,
    provider: () => provider(),
    now: new Date(Date.now() + 31 * 60 * 1000),
  });
  assert.equal(result.outcome, 'marked_failed');
  assert.equal(await payoutStatus(s, payoutId), 'FAILED');
  assert.equal((await heldIssues(s, payoutId)).length, 0);
  // Switching on leaves it failed.
  const fake = provider();
  const before = (await s.startJobs(payoutId)).length;
  await s.pause(false);
  assert.equal((await s.startJobs(payoutId)).length, before);
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'already',
  );
  assert.equal(fake.calls.creates, 0);
});

test('a person may decide it is theirs: Resume sends it once, but a hold placed after that stops it again', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const { issueId } = await freeze(s);
  await secure(s, issueId);
  const [{ id: heldIssue }] = await heldIssues(s, payoutId);
  const resume = () =>
    resumeHeldPayout(s.db, {
      issueId: heldIssue,
      reason: REASON,
      staffUserId: STAFF,
      provider: () => provider(),
    });
  assert.equal((await resume()).outcome, 'resumed');
  // Its job has not run, and another hold comes and goes.
  await rawHold(s, { released: true });
  const fake = provider();
  assert.equal(await startPayout(s.db, { payoutId, provider: fake }), 'held');
  assert.equal(fake.calls.creates, 0);
  // Decided again, after that hold.
  assert.equal((await resume()).outcome, 'resumed');
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'started',
  );
  assert.equal(fake.calls.creates, 1);
});

test('a hold that ended before the request has no bearing on it', async (t) => {
  const s = await setup(t);
  const { issueId } = await freeze(s);
  await secure(s, issueId);
  const payoutId = await s.withdraw();
  const fake = provider();
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'started',
  );
  assert.equal(fake.calls.creates, 1);
});

test('the row is seeded on, and with no row at all everything reads as off', async (t) => {
  const s = await setup(t);
  assert.deepEqual(
    await s.q(
      'SELECT id, paused, changed_by, changed_at FROM withdrawals_switch',
    ),
    [{ id: 'global', paused: false, changed_by: null, changed_at: null }],
  );
  const payoutId = await s.withdraw();
  await s.q('DELETE FROM withdrawals_switch');
  assert.deepEqual(await withdrawalsSwitchState(s.db), {
    paused: true,
    changedAt: null,
  });
  const fake = provider();
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'switched_off',
  );
  assert.equal(fake.calls.creates, 0);
  await assert.rejects(s.withdraw(), { code: 'WITHDRAWALS_SWITCHED_OFF' });
  // Switching on puts the row back and picks up what was waiting.
  assert.equal((await s.pause(false)).changed, true);
  assert.equal((await withdrawalsSwitchState(s.db)).paused, false);
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fake }),
    'started',
  );
});

/*
 * Holds and payouts get some times from the database and, before this was fixed, others from the
 * app. The two clocks differ: a request must not pass, or stop, because of which one is ahead.
 */
for (const [label, skewMs] of [
  ['ahead of', 5000],
  ['behind', -5000],
]) {
  const skewed = (t) => {
    const real = Date.now();
    t.mock.timers.enable({ apis: ['Date'], now: real + skewMs });
  };

  test(`app clock ${label} the database: a hold after Resume still stops it, and a Resume after it counts`, async (t) => {
    const s = await setup(t);
    skewed(t);
    const payoutId = await s.withdraw();
    const { issueId } = await freeze(s);
    await secure(s, issueId);
    const [{ id: heldIssue }] = await heldIssues(s, payoutId);
    const resume = () =>
      resumeHeldPayout(s.db, {
        issueId: heldIssue,
        reason: REASON,
        staffUserId: STAFF,
        provider: () => provider(),
      });
    assert.equal((await resume()).outcome, 'resumed');
    await new Promise((resolve) => setImmediate(resolve));
    await rawHold(s, { released: true });
    const fake = provider();
    assert.equal(await startPayout(s.db, { payoutId, provider: fake }), 'held');
    assert.equal(fake.calls.creates, 0);
    assert.equal((await resume()).outcome, 'resumed');
    assert.equal(
      await startPayout(s.db, { payoutId, provider: fake }),
      'started',
    );
  });

  test(`app clock ${label} the database: a hold released before the request has no bearing`, async (t) => {
    const s = await setup(t);
    skewed(t);
    const { issueId } = await freeze(s);
    await secure(s, issueId);
    const payoutId = await s.withdraw();
    const fake = provider();
    assert.equal(
      await startPayout(s.db, { payoutId, provider: fake }),
      'started',
    );
  });
}
