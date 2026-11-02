import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  applyReportedPayout,
  balanceOf,
  createPaymentIntent,
  createQuote,
  freezeWithdrawals,
  holdWithdrawals,
  markAttemptInitiated,
  markPayoutFailedAbsent,
  openIssue,
  PAYOUT_NOT_FOUND_AFTER_MS,
  PAYOUT_STUCK_AFTER_MS,
  readPayoutIssue,
  recordPayoutOutcome,
  recordProviderEvent,
  requestWithdrawal,
  resolveIssue,
  resumeHeldPayout,
  startPayout,
  withdrawalHoldPins,
  withdrawalQuote,
} from '../../dist/index.js';
import { TOBI, useDatabase } from './helpers.mjs';

const STAFF = '00000000-0000-7000-8000-00000000abcd';
const REASON = 'Checked it in the provider dashboard.';
const MS = PAYOUT_NOT_FOUND_AFTER_MS;

/** A provider whose reads are scripted and whose writes fail the test: staff tools never send. */
function fakeProvider({ find = async () => null, fetch } = {}) {
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
      return { providerReference: 'mock_out_new', status: 'pending' };
    },
    findPayoutByReference: find,
    fetchPayoutStatus: fetch ?? (async () => ({ status: 'not_found' })),
  };
}

async function setup(t) {
  const database = await useDatabase(t);
  await database.fresh();
  const { db } = database;
  const q = (sql, params) =>
    database.pool.query(sql, params).then((r) => r.rows);
  const quote = await createQuote(db, {
    handle: 'tobi',
    tipMinor: 200000n,
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
    amountMinor: 200000n,
    currency: 'NGN',
    providerFeeMinor: 3000n,
    signatureVerified: true,
    payload: {},
  });
  const withdraw = async () =>
    (
      await requestWithdrawal(db, {
        profileId: TOBI,
        amountMinor: 100000n,
        idempotencyKey: randomUUID(),
        provider: fakeProvider(),
      })
    ).payoutId;
  const available = async () => (await balanceOf(db, TOBI)).availableMinor;
  const issueFor = async (payoutId, kind = 'payout_unresolved', key) =>
    (
      await openIssue(db, {
        dedupeKey: key ?? `${kind}.${payoutId}`,
        kind,
        subject: { payoutId },
        now: new Date(),
      })
    ).id;
  const hold = async (kind = 'payment_reversed', reason = 'reversal') => {
    const issue = await openIssue(db, {
      dedupeKey: `hold.${randomUUID()}`,
      kind,
      subject: { profileId: TOBI },
      now: new Date(),
    });
    await db.transaction((tx) =>
      holdWithdrawals(tx, { profileId: TOBI, reason, issueId: issue.id }),
    );
    return issue.id;
  };
  const ledgerRows = async () =>
    (await q('SELECT count(*)::int AS n FROM ledger_entries'))[0].n;
  const statusOf = async (payoutId) =>
    (await q('SELECT status FROM payouts WHERE id = $1', [payoutId]))[0].status;
  const issueStatus = async (id) =>
    (await q('SELECT status FROM issues WHERE id = $1', [id]))[0].status;
  const later = () => new Date(Date.now() + MS + 60_000);
  return {
    db,
    q,
    withdraw,
    available,
    issueFor,
    hold,
    ledgerRows,
    statusOf,
    issueStatus,
    later,
  };
}

const offers = (view) => view.offers;
const resolver = (provider) => () => provider;

test('the read says what the provider says, and changes nothing', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId);
  const before = await s.ledgerRows();
  // The wait for a payout never tried goes by the database's clock, so its age is set there.
  await s.q(
    `UPDATE payouts SET created_at = now() - interval '31 minutes' WHERE id = $1`,
    [payoutId],
  );
  const absent = await readPayoutIssue(s.db, {
    issueId,
    staffUserId: STAFF,
    provider: resolver(fakeProvider()),
  });
  assert.equal(absent.read.state, 'absent');
  assert.equal(absent.startStep, null);
  assert.deepEqual(offers(absent), {
    applyReported: null,
    resume: true,
    markFailed: true,
  });

  const paid = await readPayoutIssue(s.db, {
    issueId,
    staffUserId: STAFF,
    provider: resolver(
      fakeProvider({
        find: async () => ({ providerReference: 'ref_1', status: 'paid' }),
      }),
    ),
  });
  assert.equal(paid.read.state, 'paid');
  assert.deepEqual(offers(paid), {
    applyReported: 'paid',
    resume: false,
    markFailed: false,
  });

  for (const find of [
    async () => {
      throw new Error('down');
    },
    async () => {
      const error = new Error('two');
      error.name = 'AmbiguousPayoutError';
      throw error;
    },
  ]) {
    const unclear = await readPayoutIssue(s.db, {
      issueId,
      staffUserId: STAFF,
      provider: resolver(fakeProvider({ find })),
      now: s.later(),
    });
    assert.ok(['uncertain', 'ambiguous'].includes(unclear.read.state));
    assert.deepEqual(offers(unclear), {
      applyReported: null,
      resume: false,
      markFailed: false,
    });
  }
  assert.equal(await s.ledgerRows(), before);
  assert.equal(await s.statusOf(payoutId), 'REQUESTED');
  const audits = await s.q(
    `SELECT permission FROM audit_events WHERE action = 'payout.staff_read'`,
  );
  assert.ok(audits.length >= 4);
  assert.ok(audits.every((a) => a.permission === 'payouts.resolve'));
});

test('applying a paid read books it once and closes the issue', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId);
  const provider = fakeProvider({
    find: async () => ({ providerReference: 'ref_paid', status: 'paid' }),
  });
  // What staff saw was different from what the provider says now: nothing happens.
  const stale = await applyReportedPayout(s.db, {
    issueId,
    reported: 'failed',
    reason: REASON,
    staffUserId: STAFF,
    provider: resolver(provider),
  });
  assert.equal(stale.outcome, 'not_offered');
  assert.equal(await s.statusOf(payoutId), 'REQUESTED');

  const done = await applyReportedPayout(s.db, {
    issueId,
    reported: 'paid',
    reason: REASON,
    staffUserId: STAFF,
    provider: resolver(provider),
  });
  assert.equal(done.outcome, 'applied');
  assert.equal(await s.statusOf(payoutId), 'PAID');
  assert.equal(await s.issueStatus(issueId), 'resolved');
  assert.equal(provider.calls.creates, 0);
  const audit = await s.q(
    `SELECT reason, permission FROM audit_events WHERE action = 'payout.staff_applied'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].permission, 'payouts.resolve');
  assert.match(audit[0].reason, /Checked it/);
});

test('a read that differs from the request is never applied and opens a conflict', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId);
  const provider = fakeProvider({
    find: async () => ({
      providerReference: 'ref_x',
      status: 'paid',
      amountMinor: 999n,
    }),
  });
  const view = await readPayoutIssue(s.db, {
    issueId,
    staffUserId: STAFF,
    provider: resolver(provider),
  });
  assert.deepEqual(view.read.differing, ['amount']);
  assert.equal(view.offers.applyReported, null);
  const before = await s.ledgerRows();
  const result = await applyReportedPayout(s.db, {
    issueId,
    reported: 'paid',
    reason: REASON,
    staffUserId: STAFF,
    provider: resolver(provider),
  });
  assert.equal(result.outcome, 'mismatch');
  assert.equal(await s.statusOf(payoutId), 'REQUESTED');
  assert.equal(await s.ledgerRows(), before);
  assert.equal(
    (await s.q(`SELECT 1 FROM issues WHERE kind = 'payout_conflict'`)).length,
    1,
  );
});

test('a reference the lookup disagrees with offers nothing, so a failure cannot release a paid twin', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.q(`UPDATE payouts SET provider_reference = 'ref_one' WHERE id = $1`, [
    payoutId,
  ]);
  const issueId = await s.issueFor(
    payoutId,
    'payout_conflict',
    `payout_conflict.two_references.${payoutId}`,
  );
  const view = await readPayoutIssue(s.db, {
    issueId,
    staffUserId: STAFF,
    provider: resolver(
      fakeProvider({
        fetch: async () => ({ status: 'failed', failureReason: 'other' }),
        find: async () => ({ providerReference: 'ref_two', status: 'paid' }),
      }),
    ),
  });
  assert.equal(view.read.state, 'conflicting');
  assert.deepEqual(offers(view), {
    applyReported: null,
    resume: false,
    markFailed: false,
  });
});

test('a held payout resumes only with no hold and no attempt, and only re-queues the job', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const provider = fakeProvider();
  const issueId = await s.issueFor(payoutId, 'payout_held');
  const holdIssue = await s.hold();
  const held = await resumeHeldPayout(s.db, {
    issueId,
    reason: REASON,
    staffUserId: STAFF,
    provider: resolver(provider),
  });
  assert.equal(held.outcome, 'not_offered');
  assert.equal(held.view.holdActive, true);

  // The held payout's own issue doesn't keep the hold in place: it could never resume otherwise.
  await resolveIssue(s.db, {
    issueId: holdIssue,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'written_off',
  });
  const jobs = () =>
    s.q(
      `SELECT dedupe_key FROM outbox_events WHERE event_type = 'payouts.start' AND aggregate_id = $1`,
      [payoutId],
    );
  assert.equal((await jobs()).length, 1);
  const resumed = await resumeHeldPayout(s.db, {
    issueId,
    reason: REASON,
    staffUserId: STAFF,
    provider: resolver(provider),
  });
  assert.equal(resumed.outcome, 'resumed');
  assert.equal((await jobs()).length, 2);
  assert.equal(provider.calls.creates, 0);
  assert.equal(await s.issueStatus(issueId), 'open');
  assert.equal(
    await startPayout(s.db, { payoutId, provider: fakeProvider() }),
    'started',
  );

  // It has been attempted now: a further resume is refused.
  const again = await resumeHeldPayout(s.db, {
    issueId,
    reason: REASON,
    staffUserId: STAFF,
    provider: resolver(provider),
  });
  assert.equal(again.outcome, 'not_offered');
  assert.equal((await jobs()).length, 2);
});

test('mark failed needs a definite absence past the wait, and the short wait is not enough after a payout step, then releases once', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId);
  const base = {
    issueId,
    reason: REASON,
    staffUserId: STAFF,
    dashboardVerified: true,
  };
  const reserved = await s.available();

  const tooSoon = await markPayoutFailedAbsent(s.db, {
    ...base,
    provider: resolver(fakeProvider()),
  });
  assert.equal(tooSoon.outcome, 'not_offered');

  await s.q(
    `UPDATE payouts SET start_uncertain_at = now(), start_step = 'payout' WHERE id = $1`,
    [payoutId],
  );
  const sent = await markPayoutFailedAbsent(s.db, {
    ...base,
    provider: resolver(fakeProvider()),
    now: s.later(),
  });
  assert.equal(sent.outcome, 'not_offered');
  assert.equal(sent.view.startStep, 'payout');
  assert.equal(sent.view.offers.markFailed, false);

  await s.q(`UPDATE payouts SET start_step = 'fee' WHERE id = $1`, [payoutId]);
  const unreadable = await markPayoutFailedAbsent(s.db, {
    ...base,
    provider: resolver(
      fakeProvider({
        find: async () => {
          throw new Error('down');
        },
      }),
    ),
    now: s.later(),
  });
  assert.equal(unreadable.outcome, 'not_offered');

  const ledgerBefore = await s.ledgerRows();
  const done = await markPayoutFailedAbsent(s.db, {
    ...base,
    provider: resolver(fakeProvider()),
    now: s.later(),
  });
  assert.equal(done.outcome, 'marked_failed');
  assert.equal(await s.statusOf(payoutId), 'FAILED');
  assert.equal(await s.available(), reserved + 100000n);
  assert.equal(await s.ledgerRows(), ledgerBefore);
  assert.equal(await s.issueStatus(issueId), 'resolved');
  const audit = await s.q(
    `SELECT permission, reason FROM audit_events WHERE action = 'payout.staff_marked_failed'`,
  );
  assert.equal(audit.length, 1);
  assert.equal(audit[0].permission, 'payouts.resolve');
  // The time the start was tried outlives the mark being cleared.
  assert.match(audit[0].reason, /start attempted \d{4}-\d{2}-\d{2}T/);

  // It says what happened: a staff decision, with no provider event dressed up as signed.
  assert.deepEqual(
    await s.q(
      `SELECT cause::text, provider_event_id FROM status_transitions
        WHERE entity_id = $1 AND to_status = 'FAILED'`,
      [payoutId],
    ),
    [{ cause: 'staff', provider_event_id: null }],
  );
  assert.equal(
    (
      await s.q('SELECT 1 FROM provider_events WHERE payout_id = $1', [
        payoutId,
      ])
    ).length,
    0,
  );
  assert.equal(
    (
      await s.q('SELECT resolution_outcome FROM issues WHERE id = $1', [
        issueId,
      ])
    )[0].resolution_outcome,
    'staff_confirmed_absent',
  );
  assert.equal(
    (
      await s.q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'payout.failed' AND aggregate_id = $1`,
        [payoutId],
      )
    ).length,
    1,
  );
  const again = await markPayoutFailedAbsent(s.db, {
    ...base,
    provider: resolver(fakeProvider()),
    now: s.later(),
  });
  assert.equal(again.outcome, 'not_open');
  assert.equal(await s.available(), reserved + 100000n);

  // If the provider later says it paid after all, that is still a conflict someone sees.
  const late = await recordPayoutOutcome(s.db, {
    payoutId,
    provider: 'mock',
    providerEventId: `late.${payoutId}`,
    providerReference: 'ref_late',
    outcome: 'paid',
    signatureVerified: true,
    payload: {},
  });
  assert.equal(late.outcome, 'conflict');
  assert.equal(
    (
      await s.q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'payout.conflict' AND aggregate_id = $1`,
        [payoutId],
      )
    ).length,
    1,
  );
});

test('an open conflict about the payout stops mark failed', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId);
  await s.issueFor(
    payoutId,
    'payout_conflict',
    `payout_conflict.mismatch.${payoutId}`,
  );
  const result = await markPayoutFailedAbsent(s.db, {
    issueId,
    reason: REASON,
    staffUserId: STAFF,
    dashboardVerified: true,
    provider: resolver(fakeProvider()),
    now: s.later(),
  });
  assert.equal(result.outcome, 'not_offered');
  assert.equal(result.view.openConflict, true);
  assert.equal(await s.statusOf(payoutId), 'REQUESTED');
});

test('a payout issue cannot be closed by hand while its payout is unfinished', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const refused = async (issueId) =>
    assert.rejects(
      resolveIssue(s.db, {
        issueId,
        staffUserId: STAFF,
        reason: REASON,
        outcome: 'written_off',
      }),
      (error) => error.code === 'ISSUE_PAYOUT_UNFINISHED',
    );
  const kinds = ['payout_unresolved', 'payout_held', 'payout_conflict'];
  const opened = [];
  for (const kind of kinds) opened.push(await s.issueFor(payoutId, kind));
  // Queued; start tried with no answer; accepted by the provider.
  for (const issueId of opened) await refused(issueId);
  await s.q(
    `UPDATE payouts SET start_uncertain_at = now(), start_step = 'payout' WHERE id = $1`,
    [payoutId],
  );
  for (const issueId of opened) await refused(issueId);
  await recordPayoutOutcome(s.db, {
    payoutId,
    provider: 'mock',
    providerEventId: `processing.${payoutId}`,
    providerReference: 'ref_accepted',
    outcome: 'processing',
    signatureVerified: true,
    payload: {},
  });
  assert.equal(await s.statusOf(payoutId), 'PROCESSING');
  for (const issueId of opened) await refused(issueId);
  for (const issueId of opened)
    assert.equal(await s.issueStatus(issueId), 'open');

  // Finished, a person can close it.
  await recordPayoutOutcome(s.db, {
    payoutId,
    provider: 'mock',
    providerEventId: `paid.${payoutId}`,
    providerReference: 'ref_accepted',
    outcome: 'paid',
    signatureVerified: true,
    payload: {},
  });
  await resolveIssue(s.db, {
    issueId: opened[2],
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'resolved_by_provider',
  });
  assert.equal(await s.issueStatus(opened[2]), 'resolved');
});

test('a hold whose cause is open survives a release triggered by closing another issue', async (t) => {
  const s = await setup(t);
  // Its cause isn't found by the recipient search, as a hold committed just after that search isn't.
  const cause = await openIssue(s.db, {
    dedupeKey: `unseen.${randomUUID()}`,
    kind: 'payout_unexpected',
    subject: { unmatchedId: randomUUID() },
    now: new Date(),
  });
  await s.db.transaction((tx) =>
    holdWithdrawals(tx, {
      profileId: TOBI,
      reason: 'unexpected_payout',
      issueId: cause.id,
    }),
  );
  const closing = await s.hold();
  await resolveIssue(s.db, {
    issueId: closing,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'written_off',
  });
  const held = await s.q(
    'SELECT issue_id, released_at FROM withdrawal_holds ORDER BY created_at',
  );
  assert.equal(held.find((h) => h.issue_id === cause.id).released_at, null);
  assert.ok(held.find((h) => h.issue_id === closing).released_at);
});

test('who applied and why is written before the apply', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId);
  const provider = fakeProvider({
    find: async () => ({ providerReference: 'ref_a', status: 'paid' }),
  });
  const done = await applyReportedPayout(s.db, {
    issueId,
    reported: 'paid',
    reason: REASON,
    staffUserId: STAFF,
    provider: resolver(provider),
  });
  assert.equal(done.outcome, 'applied');
  const rows = await s.q(
    `SELECT reason, seq FROM audit_events WHERE action IN ('payout.staff_apply_requested', 'payout.staff_applied') ORDER BY seq`,
  );
  assert.equal(rows.length, 2);
  assert.match(rows[0].reason, /Checked it/);
});

test('a signed event naming the payout means "the provider has none" is not believed', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId);
  await s.q(
    `INSERT INTO unmatched_provider_events
       (id, provider, provider_event_id, event_type, payload_hash, payload, reason)
     VALUES ($1, 'bachs', 'evt_parked', 'payout.paid', 'h', $2, 'unknown_payout')`,
    [randomUUID(), JSON.stringify({ operationReference: payoutId })],
  );
  const parked = await markPayoutFailedAbsent(s.db, {
    issueId,
    reason: REASON,
    staffUserId: STAFF,
    dashboardVerified: true,
    provider: resolver(fakeProvider()),
    now: s.later(),
  });
  assert.equal(parked.outcome, 'not_offered');
  assert.equal(parked.view.parkedEvent, true);
  assert.equal(await s.statusOf(payoutId), 'REQUESTED');
});

test('the tools act only on withdrawal issues', async (t) => {
  const s = await setup(t);
  const other = await s.hold();
  await assert.rejects(
    readPayoutIssue(s.db, {
      issueId: other,
      staffUserId: STAFF,
      provider: resolver(fakeProvider()),
    }),
    (error) => error.code === 'ISSUE_NOT_FOUND',
  );
});

test('a start marked failed while it was topping up the fee never sends the payout', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.q(
    `UPDATE payouts SET account_reference = 'acct_1', provider = 'bachs',
       destination_id = NULL WHERE id = $1`,
    [payoutId],
  );
  const [{ id: destinationId }] = await s.q(
    `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
     VALUES ($1, $2, 'bachs', 'dest_1', '058', 'Bank', '1234', 'usable') RETURNING id`,
    [randomUUID(), TOBI],
  );
  await s.q(`UPDATE payouts SET destination_id = $1 WHERE id = $2`, [
    destinationId,
    payoutId,
  ]);
  const provider = {
    ...fakeProvider(),
    capabilities: { connectedAccounts: true },
    coverPayoutFee: async () => {
      await recordPayoutOutcome(s.db, {
        payoutId,
        provider: 'bachs',
        providerEventId: `staff.${payoutId}`,
        providerReference: null,
        outcome: 'failed',
        signatureVerified: true,
        payload: {},
      });
      return { transferRef: 'tr_1' };
    },
  };
  assert.equal(await startPayout(s.db, { payoutId, provider }), 'uncertain');
  assert.equal(provider.calls.creates, 0);
});

test('a hold is never placed for an issue already closed', async (t) => {
  const s = await setup(t);
  const issue = await openIssue(s.db, {
    dedupeKey: `closed.${randomUUID()}`,
    kind: 'provider_in_debt',
    subject: { profileId: TOBI },
    now: new Date(),
  });
  await resolveIssue(s.db, {
    issueId: issue.id,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'recipient_owes',
  });
  await s.db.transaction((tx) =>
    holdWithdrawals(tx, {
      profileId: TOBI,
      reason: 'in_debt',
      issueId: issue.id,
    }),
  );
  assert.equal(
    (await s.q('SELECT 1 FROM withdrawal_holds WHERE released_at IS NULL'))
      .length,
    0,
  );
});

test('a payout issue with no hold of its own never pins a hold', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  await s.issueFor(payoutId);
  const failed = await openIssue(s.db, {
    dedupeKey: `event.payout.failed.${randomUUID()}`,
    kind: 'payout_failed',
    subject: { profileId: TOBI },
    now: new Date(),
  });
  const shortFee = await openIssue(s.db, {
    dedupeKey: `fee.${randomUUID()}`,
    kind: 'payout_fee_short',
    subject: { profileId: TOBI },
    now: new Date(),
  });
  const holdIssue = await s.hold();
  await resolveIssue(s.db, {
    issueId: holdIssue,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'written_off',
  });
  // Week 1's failure and an unresolved start say nothing about this reversal.
  assert.equal(
    (await s.q('SELECT 1 FROM withdrawal_holds WHERE released_at IS NULL'))
      .length,
    0,
  );
  assert.equal(await s.issueStatus(failed.id), 'open');
  assert.equal(await s.issueStatus(shortFee.id), 'open');
});

test('a hold that cannot release says which issues pin it', async (t) => {
  const s = await setup(t);
  const closing = await s.hold();
  const debt = await s.hold('provider_in_debt', 'in_debt');
  await resolveIssue(s.db, {
    issueId: closing,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'written_off',
  });
  const pins = await withdrawalHoldPins(s.db, { profileId: TOBI });
  assert.equal(pins.length, 1);
  assert.equal(pins[0].id, debt);
  assert.equal(pins[0].kind, 'provider_in_debt');
  const [audit] = await s.q(
    `SELECT reason, subject_id FROM audit_events WHERE action = 'withdrawals.still_held'`,
  );
  assert.equal(audit.subject_id, TOBI);
  assert.match(audit.reason, /provider_in_debt/);
  await resolveIssue(s.db, {
    issueId: debt,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'written_off',
  });
  assert.deepEqual(await withdrawalHoldPins(s.db, { profileId: TOBI }), []);
});

test('closing other issues never releases a takeover freeze', async (t) => {
  const s = await setup(t);
  const freeze = await freezeWithdrawals(s.db, {
    profileId: TOBI,
    staffUserId: STAFF,
    reason: REASON,
  });
  const failed = await openIssue(s.db, {
    dedupeKey: `event.payout.failed.${randomUUID()}`,
    kind: 'payout_failed',
    subject: { profileId: TOBI },
    now: new Date(),
  });
  const reversal = await s.hold();
  const active = async () =>
    (
      await s.q(
        `SELECT 1 FROM withdrawal_holds WHERE released_at IS NULL AND reason = 'account_takeover'`,
      )
    ).length;
  for (const issueId of [failed.id, reversal]) {
    await resolveIssue(s.db, {
      issueId,
      staffUserId: STAFF,
      reason: REASON,
      outcome: 'written_off',
    });
    assert.equal(await active(), 1);
  }
  // Even a takeover issue closed some other way than "the owner has it back" keeps its freeze.
  await s.q(
    `UPDATE issues SET status = 'resolved', resolved_at = now(), resolved_by = 'system' WHERE id = $1`,
    [freeze.issueId],
  );
  const another = await s.hold();
  await resolveIssue(s.db, {
    issueId: another,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'written_off',
  });
  assert.equal(await active(), 1);
});

test('a failed balance read reaches the caller by name only, never with account data', async (t) => {
  const s = await setup(t);
  const failures = [];
  const quote = await withdrawalQuote(s.db, {
    profileId: TOBI,
    provider: {
      ...fakeProvider(),
      payoutBalance: async () => {
        throw new TypeError('acct_secret_123 was refused');
      },
    },
    onReadFailure: (failure) => failures.push(failure),
  });
  assert.equal(quote.state, 'provider_unavailable');
  assert.deepEqual(failures, [{ error: 'TypeError' }]);
});

test('a create that died: 24 hours on, a definite absence and a dashboard check release it', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId);
  await s.q(
    `UPDATE payouts SET start_uncertain_at = now(), start_step = 'payout' WHERE id = $1`,
    [payoutId],
  );
  const base = { issueId, reason: REASON, staffUserId: STAFF };
  const reserved = await s.available();
  const dayOn = new Date(Date.now() + PAYOUT_STUCK_AFTER_MS + 60_000);
  const failedRead = (name) =>
    fakeProvider({
      find: async () => {
        throw Object.assign(new Error('no'), { name });
      },
    });

  // Before the wait, even a definite absence isn't enough: money may have left.
  const early = await readPayoutIssue(s.db, {
    ...base,
    provider: resolver(fakeProvider()),
    now: new Date(Date.now() + PAYOUT_STUCK_AFTER_MS - 60_000),
  });
  assert.equal(early.read.state, 'absent');
  assert.equal(offers(early).markFailed, false);

  // Past it, an unclear or unavailable read doesn't count, and neither does a found one.
  for (const provider of [
    failedRead('AmbiguousPayoutError'),
    failedRead('UncertainProviderOutcomeError'),
    fakeProvider({
      find: async () => ({ providerReference: 'r', status: 'pending' }),
    }),
  ]) {
    const refused = await markPayoutFailedAbsent(s.db, {
      ...base,
      dashboardVerified: true,
      provider: resolver(provider),
      now: dayOn,
    });
    assert.equal(refused.outcome, 'not_offered');
    assert.equal(await s.statusOf(payoutId), 'REQUESTED');
  }

  // No box, no release, whatever the provider says.
  await assert.rejects(
    markPayoutFailedAbsent(s.db, {
      ...base,
      provider: resolver(fakeProvider()),
      now: dayOn,
    }),
    /INVALID_INPUT/,
  );

  // The provider accepted it once: "not found" now is a puzzle, not a definite absence.
  await s.q(
    `UPDATE payouts SET provider_reference = 'acct:po_1' WHERE id = $1`,
    [payoutId],
  );
  const referenced = await readPayoutIssue(s.db, {
    ...base,
    provider: resolver(fakeProvider()),
    now: dayOn,
  });
  assert.equal(offers(referenced).markFailed, false);
  await s.q(`UPDATE payouts SET provider_reference = NULL WHERE id = $1`, [
    payoutId,
  ]);

  const done = await markPayoutFailedAbsent(s.db, {
    ...base,
    dashboardVerified: true,
    provider: resolver(fakeProvider()),
    now: dayOn,
  });
  assert.equal(done.outcome, 'marked_failed');
  assert.equal(await s.statusOf(payoutId), 'FAILED');
  assert.equal(await s.available(), reserved + 100000n);
  const [audit] = await s.q(
    `SELECT reason FROM audit_events WHERE action = 'payout.staff_marked_failed'`,
  );
  assert.match(audit.reason, /start step payout/);
  assert.match(audit.reason, /dashboardVerified/);
});

test('the Resume view says when a hold touched the withdrawal', async (t) => {
  const s = await setup(t);
  const payoutId = await s.withdraw();
  const issueId = await s.issueFor(payoutId, 'payout_held');
  const read = () =>
    readPayoutIssue(s.db, {
      issueId,
      staffUserId: STAFF,
      provider: resolver(fakeProvider()),
    });
  assert.equal((await read()).holdTouched, false);
  const holdIssue = await s.hold();
  await resolveIssue(s.db, {
    issueId: holdIssue,
    staffUserId: STAFF,
    reason: REASON,
    outcome: 'written_off',
  });
  const view = await read();
  assert.equal(view.holdActive, false);
  assert.equal(view.holdTouched, true);
  assert.equal(offers(view).resume, true);
});
