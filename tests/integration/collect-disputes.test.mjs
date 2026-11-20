import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  PayoutRejectedError,
  UncertainProviderOutcomeError,
} from '../../packages/payments/dist/index.js';
import { setSwitch } from './helpers.mjs';

/*
 * You collect (plan Task 9, spec §6.2, R4, R6, P13, P14, P20, P27): a dispute on a tip TipMe
 * collected is TipMe's. Opening it books the partner's fee (only when the partner reports one),
 * holds the recipient's share (still held: the share goes to review; already moved: that amount of
 * their balance), and tells them. Won releases the hold. Lost recovers from the recipient's unpaid
 * balance first (the held share, then a transfer back), and TipMe absorbs the rest. A share whose
 * transfer may be in flight is never touched until its read-back settles it. No partner is called:
 * a fake answers instead.
 */

const [ADA, TOBI] = ops.DEMO_PROFILES;
const GROSS = 1_000_000n; // ₦10,000 on Free: TipMe keeps 5%.
const NET = 950_000n;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date(Math.floor(Date.now() / MIN) * MIN - 3 * DAY);
const at = (ms) => new Date(T0.getTime() + ms);
const ACCOUNTS = {
  [TOBI.id]: 'acct_tobi_person',
  [ADA.id]: 'acct_ada_person',
};

let database;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
});
after(async () => {
  await setSwitch(database.pool, 'you_collect', false);
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await setSwitch(database.pool, 'you_collect', true);
  await q(`UPDATE profiles SET created_at = $1`, [at(-30 * DAY)]);
});

async function verified(profile) {
  await q(
    `UPDATE profiles SET collection_mode = 'collect', collect_verified_at = $2 WHERE id = $1`,
    [profile.id, at(-DAY)],
  );
  await q(
    `INSERT INTO payment_accounts (id, profile_id, provider, environment, provider_account_reference, status)
     VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ONBOARDING')`,
    [randomUUID(), profile.id, ACCOUNTS[profile.id]],
  );
  await q(
    `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
     VALUES ($1, $2, 'bachs', $3, '058', 'Pretend Guaranty Bank', '1234', 'usable')`,
    [randomUUID(), profile.id, `dest_${profile.handle}`],
  );
}

/** A paid collect tip (Task 7): held money and one waiting share. */
async function paidTip(profile, settledAt = T0) {
  const { db } = database;
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    profile.id,
  ]);
  const quote = await ops.createQuote(db, {
    handle: profile.handle,
    tipMinor: GROSS,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
  });
  await q(`UPDATE payment_attempts SET created_at = $2 WHERE id = $1`, [
    intent.attemptId,
    new Date(settledAt.getTime() - MIN),
  ]);
  const chargeReference = `ch_${randomUUID().slice(0, 8)}`;
  const result = await ops.reconcileAttempts({
    db,
    provider: {
      environment: 'sandbox',
      async verifyTransaction() {
        return {
          status: 'succeeded',
          amountMinor: GROSS,
          currency: 'NGN',
          feeMinor: 20_000n,
          feePaidBy: 'platform',
          method: 'NGN_CARD',
          chargeReference,
        };
      },
    },
    now: settledAt,
    minAgeMs: 0,
    attemptId: intent.attemptId,
  });
  assert.equal(result.applied, 1);
  const [row] = await q(
    `SELECT id FROM collect_transfers WHERE tip_id = $1 AND kind = 'share'`,
    [intent.tipId],
  );
  return {
    tipId: intent.tipId,
    attemptId: intent.attemptId,
    rowId: row.id,
    key: `tipme-collect-${intent.tipId}`,
    chargeReference,
    disputeRef: `dp_${randomUUID().slice(0, 10)}`,
  };
}

/** The partner's dispute event as the adapter normalises it (Task 5). */
const disputeEvent = (tip, over = {}) => ({
  kind: 'dispute',
  eventId: `evt_${randomUUID()}`,
  eventType: 'dispute.created',
  scope: 'platform',
  partnerDisputeId: tip.disputeRef,
  chargeReference: tip.chargeReference,
  providerReference: null,
  operationReference: null,
  status: 'open',
  amountMinor: GROSS,
  currency: 'NGN',
  reason: 'fraudulent',
  respondBy: at(7 * DAY),
  feeMinor: null,
  feeCurrency: null,
  occurredAt: at(HOUR),
  ...over,
});
const apply = (event, now = at(HOUR)) =>
  ops.applyDisputeEvent(database.db, { event, provider: 'bachs', now });

/** A stand-in for the partner: shares out of TipMe's balance, and transfers back into it. */
function partner() {
  const state = {
    sends: [],
    backs: [],
    listed: [],
    answers: [],
    backAnswers: [],
  };
  const movedTo = (input, accountRef) => {
    let transfer = state.listed.find((t) => t.group === input.idempotencyKey);
    if (!transfer) {
      transfer = {
        transferRef: `tr_${state.listed.length + 1}`,
        status: 'paid',
        amountMinor: input.amountMinor,
        currency: input.currency,
        group: input.idempotencyKey,
        accountRef,
      };
      state.listed.push(transfer);
    }
    return transfer;
  };
  const provider = {
    name: 'bachs-sandbox',
    async sendCollectTransfer(input) {
      state.sends.push({ ...input });
      const answer = state.answers.shift();
      if (answer === 'lost-unmoved')
        throw new UncertainProviderOutcomeError(
          input.idempotencyKey,
          'no answer',
          {
            cause: 'no_response',
          },
        );
      const transfer = movedTo(input, input.accountRef);
      if (answer === 'lost')
        throw new UncertainProviderOutcomeError(
          input.idempotencyKey,
          'no answer',
          {
            cause: 'no_response',
          },
        );
      return { transferRef: transfer.transferRef, status: 'paid' };
    },
    async collectBack(input) {
      state.backs.push({ ...input });
      const answer = state.backAnswers.shift();
      if (answer?.reject)
        throw new PayoutRejectedError(answer.reject, answer.code);
      const transfer = movedTo(input, input.accountRef);
      return { transferRef: transfer.transferRef, status: 'paid' };
    },
    async listAccountTransfers(accountRef) {
      return state.listed
        .filter((t) => t.accountRef === accountRef)
        .map(({ accountRef: _a, ...t }) => t);
    },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
  };
  state.inGroup = (key) => state.listed.filter((t) => t.group === key).length;
  return { provider, state };
}

const run = (provider, now) =>
  ops.runCollectTransfers(database.db, { provider, now });
const release = (now) => ops.releaseWaitingTransfers(database.db, { now });
const steps = (now) => ops.runDisputeSteps(database.db, { now });
const shareOf = async (rowId) =>
  (
    await q(
      `SELECT status, review_reason, account_reference, sent_at, amount_minor::text AS amount
         FROM collect_transfers WHERE id = $1`,
      [rowId],
    )
  )[0];
const disputeOf = async (partnerDisputeId) =>
  (
    await q(
      `SELECT id, status, held_minor::text AS held, fee_minor::text AS fee, fee_currency,
              share_step, settled_at
         FROM disputes WHERE partner_dispute_id = $1`,
      [partnerDisputeId],
    )
  )[0];
const linesOf = (operationKey) =>
  q(
    `SELECT a.code, CASE WHEN a.profile_id IS NULL THEN 'tipme' ELSE 'person' END AS owner,
            e.side::text AS side, e.amount_minor::text AS amount, e.currency
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.operation_key = $1 ORDER BY a.code, e.side`,
    [operationKey],
  );
const issuesOf = (kind) =>
  q(
    `SELECT dedupe_key, status FROM issues WHERE kind = $1 ORDER BY opened_at`,
    [kind],
  );
const available = async (profile) =>
  (await ops.balanceOf(database.db, profile.id)).availableMinor;
/** A withdrawal in flight: what it sends is reserved from the balance. */
const withdrawing = (profile, amountMinor) =>
  q(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint)
     VALUES ($1, $2, 'NGN', $3, 'REQUESTED', $4, 'test')`,
    [randomUUID(), profile.id, amountMinor, randomUUID()],
  );
/** A tip whose share has reached the recipient's account. */
async function movedTip(profile, provider) {
  const tip = await paidTip(profile);
  await release(T0);
  await run(provider, T0);
  assert.equal((await shareOf(tip.rowId)).status, 'paid');
  return tip;
}
const lossLines = (recoveredMinor, absorbedMinor) => [
  ...(absorbedMinor > 0n
    ? [
        {
          code: 'dispute_loss_expense',
          owner: 'tipme',
          side: 'debit',
          amount: String(absorbedMinor),
          currency: 'NGN',
        },
      ]
    : []),
  ...(recoveredMinor > 0n
    ? [
        {
          code: 'held_for_recipients',
          owner: 'person',
          side: 'credit',
          amount: String(recoveredMinor),
          currency: 'NGN',
        },
      ]
    : []),
  ...(absorbedMinor > 0n
    ? [
        {
          code: 'platform_clearing',
          owner: 'tipme',
          side: 'credit',
          amount: String(absorbedMinor),
          currency: 'NGN',
        },
      ]
    : []),
  ...(recoveredMinor > 0n
    ? [
        {
          code: 'recipient_payable',
          owner: 'person',
          side: 'debit',
          amount: String(recoveredMinor),
          currency: 'NGN',
        },
      ]
    : []),
];

test('created then won: the fee stays an expense and the hold is released', async () => {
  await verified(TOBI);
  const tip = await paidTip(TOBI);
  assert.equal(await release(T0), 1);
  assert.equal(
    (await apply(disputeEvent(tip, { feeMinor: 1500n, feeCurrency: 'USD' })))
      .outcome,
    'opened',
  );
  const opened = await disputeOf(tip.disputeRef);
  // Ready but never sent: held for the dispute, keeping its account (P13).
  assert.deepEqual(
    { ...(await shareOf(tip.rowId)), sent_at: undefined },
    {
      status: 'review',
      review_reason: 'dispute',
      account_reference: ACCOUNTS[TOBI.id],
      sent_at: undefined,
      amount: String(NET),
    },
  );
  assert.equal(opened.share_step, 'held');
  assert.deepEqual(await linesOf(`dispute_fee.${opened.id}`), [
    {
      code: 'dispute_fee_expense',
      owner: 'tipme',
      side: 'debit',
      amount: '1500',
      currency: 'USD',
    },
    {
      code: 'platform_clearing',
      owner: 'tipme',
      side: 'credit',
      amount: '1500',
      currency: 'USD',
    },
  ]);
  assert.equal((await issuesOf('dispute_opened')).length, 1);
  // The partner reported its fee: nothing for staff to post by hand.
  assert.deepEqual(await issuesOf('dispute_fee_unposted'), []);

  assert.equal(
    (
      await apply(
        disputeEvent(tip, {
          eventType: 'dispute.updated',
          status: 'won',
          occurredAt: at(2 * HOUR),
        }),
        at(2 * HOUR),
      )
    ).outcome,
    'won',
  );
  const won = await disputeOf(tip.disputeRef);
  assert.equal(won.status, 'won');
  assert.equal(won.held, '0');
  assert.ok(won.settled_at);
  // Released to ready with its account (P20); the fee is still booked, once; no loss.
  const share = await shareOf(tip.rowId);
  assert.equal(share.status, 'ready');
  assert.equal(share.review_reason, null);
  assert.equal((await linesOf(`dispute_fee.${won.id}`)).length, 2);
  assert.deepEqual(await linesOf(`dispute_loss.${won.id}`), []);
  // And it moves.
  const { provider, state } = partner();
  await run(provider, at(3 * HOUR));
  assert.equal((await shareOf(tip.rowId)).status, 'paid');
  assert.equal(state.sends.length, 1);
});

test('created then lost: full recovery from the held share', async () => {
  // No bank details yet: the share is still held in TipMe's balance.
  const tip = await paidTip(TOBI);
  assert.equal((await apply(disputeEvent(tip))).outcome, 'opened');
  const share = await shareOf(tip.rowId);
  assert.equal(share.status, 'review');
  assert.equal(share.review_reason, 'dispute');
  assert.equal(share.account_reference, null);
  assert.equal(
    (
      await apply(
        disputeEvent(tip, {
          eventType: 'dispute.updated',
          status: 'lost',
          occurredAt: at(2 * HOUR),
        }),
        at(2 * HOUR),
      )
    ).outcome,
    'lost',
  );
  const lost = await disputeOf(tip.disputeRef);
  assert.equal((await shareOf(tip.rowId)).status, 'cancelled');
  assert.ok(lost.settled_at);
  // Dr payable 950000, Cr held 950000, Dr loss 50000, Cr platform 50000.
  assert.deepEqual(
    await linesOf(`dispute_loss.${lost.id}`),
    lossLines(NET, GROSS - NET),
  );
  const [posting] = await q(
    `SELECT t.operation_type::text AS type, p.operation_key AS reverses
       FROM ledger_transactions t JOIN ledger_transactions p ON p.id = t.reverses_transaction_id
      WHERE t.operation_key = $1`,
    [`dispute_loss.${lost.id}`],
  );
  assert.deepEqual(posting, {
    type: 'reversal',
    reverses: `payment.${tip.attemptId}`,
  });
  assert.equal(await available(TOBI), 0n);
  assert.equal(
    await ops.settleLostDispute(database.db, {
      disputeId: lost.id,
      now: at(3 * HOUR),
    }),
    'done',
  );
});

test('created then lost: partial recovery by transfer back, TipMe absorbs the rest', async () => {
  await verified(TOBI);
  const { provider, state } = partner();
  const tip = await movedTip(TOBI, provider);
  // ₦6,500 of it is on its way to their bank: ₦3,000 is still theirs to give back.
  await withdrawing(TOBI, 650_000n);
  assert.equal(await available(TOBI), 300_000n);
  assert.equal((await apply(disputeEvent(tip))).outcome, 'opened');
  const opened = await disputeOf(tip.disputeRef);
  assert.equal(opened.share_step, 'balance');
  assert.equal(opened.held, '300000');
  // The held amount comes off what they can withdraw.
  assert.equal(await available(TOBI), 0n);
  assert.deepEqual(
    await q(
      `SELECT n.kind, n.body FROM notifications n JOIN profiles p ON p.user_id = n.user_id
        WHERE p.id = $1 AND n.kind = 'dispute_hold'`,
      [TOBI.id],
    ),
    [
      {
        kind: 'dispute_hold',
        body: "A payment to you is being questioned. We've held ₦3,000 until it's settled.",
      },
    ],
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM outbox_events WHERE event_type = 'collect.dispute_hold' AND aggregate_id = $1`,
        [opened.id],
      )
    ).length,
    1,
  );

  assert.equal(
    (
      await apply(
        disputeEvent(tip, {
          eventType: 'dispute.updated',
          status: 'lost',
          occurredAt: at(2 * HOUR),
        }),
        at(2 * HOUR),
      )
    ).outcome,
    'lost',
  );
  const [back] = await q(
    `SELECT id, kind, status, amount_minor::text AS amount, account_reference, idempotency_key
       FROM collect_transfers WHERE dispute_id = $1`,
    [opened.id],
  );
  assert.deepEqual(
    { ...back, id: undefined },
    {
      id: undefined,
      kind: 'back',
      status: 'ready',
      amount: '300000',
      account_reference: ACCOUNTS[TOBI.id],
      idempotency_key: `tipme-collect-back-${opened.id}`,
    },
  );
  assert.equal(
    await ops.settleLostDispute(database.db, {
      disputeId: opened.id,
      now: at(2 * HOUR),
    }),
    'waiting_back',
  );
  // Still held until the money is back.
  assert.equal((await disputeOf(tip.disputeRef)).held, '300000');

  // The same machine moves it back from their account to TipMe's.
  await run(provider, at(3 * HOUR));
  assert.deepEqual(state.backs, [
    {
      accountRef: ACCOUNTS[TOBI.id],
      amountMinor: 300_000n,
      currency: 'NGN',
      idempotencyKey: `tipme-collect-back-${opened.id}`,
    },
  ]);
  assert.equal(
    (
      await q(`SELECT status FROM collect_transfers WHERE id = $1`, [back.id])
    )[0].status,
    'paid',
  );
  assert.deepEqual(
    (await linesOf(`collect_transfer.${back.id}`)).map((l) => [
      l.code,
      l.side,
      l.amount,
    ]),
    [
      ['held_for_recipients', 'debit', '300000'],
      ['provider_clearing', 'credit', '300000'],
    ],
  );
  assert.equal(
    await ops.settleLostDispute(database.db, {
      disputeId: opened.id,
      now: at(3 * HOUR),
    }),
    'posted',
  );
  assert.deepEqual(
    await linesOf(`dispute_loss.${opened.id}`),
    lossLines(300_000n, GROSS - 300_000n),
  );
  const settled = await disputeOf(tip.disputeRef);
  assert.equal(settled.held, '0');
  assert.ok(settled.settled_at);
  assert.equal(
    await ops.settleLostDispute(database.db, {
      disputeId: opened.id,
      now: at(4 * HOUR),
    }),
    'done',
  );
  assert.equal(state.backs.length, 1);
});

test('created then lost: nothing to recover, TipMe absorbs all of it', async () => {
  await verified(TOBI);
  const { provider, state } = partner();
  const tip = await movedTip(TOBI, provider);
  // All of it is already on its way to their bank.
  await withdrawing(TOBI, NET);
  assert.equal((await apply(disputeEvent(tip))).outcome, 'opened');
  const opened = await disputeOf(tip.disputeRef);
  assert.equal(opened.share_step, 'balance');
  assert.equal(opened.held, '0');
  // Nothing held, so nothing to tell them.
  assert.deepEqual(
    await q(`SELECT 1 FROM notifications WHERE kind = 'dispute_hold'`),
    [],
  );
  // No fee reported (the partner documents none): staff post it by hand (R6).
  assert.deepEqual(
    (await issuesOf('dispute_fee_unposted')).map((i) => i.dedupe_key),
    [`dispute_fee_unposted.${opened.id}`],
  );
  assert.deepEqual(await linesOf(`dispute_fee.${opened.id}`), []);
  assert.equal(
    (
      await apply(
        disputeEvent(tip, {
          eventType: 'dispute.updated',
          status: 'lost',
          occurredAt: at(2 * HOUR),
        }),
        at(2 * HOUR),
      )
    ).outcome,
    'lost',
  );
  assert.deepEqual(
    await q(`SELECT 1 FROM collect_transfers WHERE kind = 'back'`),
    [],
  );
  assert.deepEqual(
    await linesOf(`dispute_loss.${opened.id}`),
    lossLines(0n, GROSS),
  );
  assert.ok((await disputeOf(tip.disputeRef)).settled_at);
  assert.equal(state.backs.length, 0);
});

test('duplicate and out-of-order dispute events change nothing twice', async () => {
  const tip = await paidTip(TOBI);
  const lost = disputeEvent(tip, {
    eventType: 'dispute.updated',
    status: 'lost',
    occurredAt: at(2 * HOUR),
  });
  const created = disputeEvent(tip, { occurredAt: at(HOUR) });
  // The ruling first.
  assert.equal((await apply(lost, at(2 * HOUR))).outcome, 'lost');
  // The older opening arrives late: it moves nothing back.
  assert.equal((await apply(created, at(3 * HOUR))).outcome, 'stale');
  assert.equal((await apply(lost, at(4 * HOUR))).outcome, 'duplicate');
  assert.equal((await apply(created, at(4 * HOUR))).outcome, 'duplicate');
  const row = await disputeOf(tip.disputeRef);
  assert.equal(row.status, 'lost');
  assert.equal((await q(`SELECT 1 FROM disputes`)).length, 1);
  assert.equal((await shareOf(tip.rowId)).status, 'cancelled');
  assert.equal(
    (
      await q(
        `SELECT 1 FROM ledger_transactions WHERE operation_key LIKE 'dispute_loss.%'`,
      )
    ).length,
    1,
  );
  assert.deepEqual(
    await linesOf(`dispute_loss.${row.id}`),
    lossLines(NET, GROSS - NET),
  );
  assert.equal((await issuesOf('dispute_opened')).length, 1);
  assert.equal((await issuesOf('dispute_fee_unposted')).length, 1);
  // Both events are kept once, against the tip's payment.
  assert.deepEqual(
    (
      await q(
        `SELECT provider_event_id, attempt_id FROM provider_events
          WHERE event_type LIKE 'dispute.%' ORDER BY provider_event_id`,
      )
    ).map((e) => e.attempt_id),
    [tip.attemptId, tip.attemptId],
  );
});

test('a dispute fee taking a balance negative is booked and raises the critical alert', async () => {
  const tip = await paidTip(TOBI);
  // TipMe holds no dollars: the partner's $15 fee takes that balance below zero. It is booked as
  // reported, never on a guess; Task 11's reserve check raises the alert on the negative balance.
  await apply(disputeEvent(tip, { feeMinor: 1500n, feeCurrency: 'USD' }));
  const row = await disputeOf(tip.disputeRef);
  assert.equal(row.fee, '1500');
  assert.equal(row.fee_currency, 'USD');
  assert.deepEqual(
    await q(
      `SELECT operation_type::text AS type, currency, tip_id FROM ledger_transactions
        WHERE operation_key = $1`,
      [`dispute_fee.${row.id}`],
    ),
    [{ type: 'dispute_fee', currency: 'USD', tip_id: tip.tipId }],
  );
  const [usd] = await q(
    `SELECT sum(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END)::text AS own
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.code = 'platform_clearing' AND a.currency = 'USD'`,
  );
  assert.equal(usd.own, '-1500');
  // Reported again on a later event: booked once.
  await apply(
    disputeEvent(tip, {
      eventType: 'dispute.updated',
      status: 'responded',
      feeMinor: 1500n,
      feeCurrency: 'USD',
      occurredAt: at(2 * HOUR),
    }),
    at(2 * HOUR),
  );
  assert.equal(
    (
      await q(
        `SELECT 1 FROM ledger_transactions WHERE operation_type = 'dispute_fee'`,
      )
    ).length,
    1,
  );
});

test('a dispute opened on a sent transfer resolves after read-back', async () => {
  await verified(TOBI);
  await verified(ADA);
  const { provider, state } = partner();
  // Tobi's share moved but the answer was lost; Ada's request never arrived.
  const moved = await paidTip(TOBI);
  const unmoved = await paidTip(ADA);
  await release(T0);
  state.answers.push('lost', 'lost-unmoved');
  await run(provider, T0);
  for (const tip of [moved, unmoved])
    assert.equal((await shareOf(tip.rowId)).status, 'unknown');

  for (const tip of [moved, unmoved]) {
    assert.equal((await apply(disputeEvent(tip))).outcome, 'opened');
    const opened = await disputeOf(tip.disputeRef);
    // In flight: nothing is held, cancelled or moved under it.
    assert.equal(opened.share_step, null);
    assert.equal(opened.held, '0');
    const share = await shareOf(tip.rowId);
    assert.equal(share.status, 'unknown');
    assert.equal(
      share.account_reference,
      ACCOUNTS[tip === moved ? TOBI.id : ADA.id],
    );
  }
  // The sweep can't decide either while the transfer is in flight.
  await steps(at(2 * HOUR));
  assert.equal((await disputeOf(moved.disputeRef)).share_step, null);

  // A day on, the key is no longer trusted: both are read back on their own accounts.
  await run(provider, at(DAY + HOUR));
  assert.equal((await shareOf(moved.rowId)).status, 'paid');
  assert.equal((await shareOf(unmoved.rowId)).status, 'waiting');
  await steps(at(DAY + HOUR));
  // Moved: that amount of the balance is held. Not moved: the share itself is held.
  const movedDispute = await disputeOf(moved.disputeRef);
  assert.equal(movedDispute.share_step, 'balance');
  assert.equal(movedDispute.held, String(NET));
  const unmovedShare = await shareOf(unmoved.rowId);
  assert.equal(unmovedShare.status, 'review');
  assert.equal(unmovedShare.review_reason, 'dispute');
  assert.equal((await disputeOf(unmoved.disputeRef)).share_step, 'held');

  // Both lost: the held share is cancelled; the moved one comes back by transfer, once.
  for (const tip of [moved, unmoved])
    await apply(
      disputeEvent(tip, {
        eventType: 'dispute.updated',
        status: 'lost',
        occurredAt: at(DAY + 2 * HOUR),
      }),
      at(DAY + 2 * HOUR),
    );
  assert.equal((await shareOf(unmoved.rowId)).status, 'cancelled');
  await run(provider, at(DAY + 3 * HOUR));
  await steps(at(DAY + 3 * HOUR));
  for (const tip of [moved, unmoved]) {
    const row = await disputeOf(tip.disputeRef);
    assert.ok(row.settled_at);
    assert.deepEqual(
      await linesOf(`dispute_loss.${row.id}`),
      lossLines(NET, GROSS - NET),
    );
  }
  // One transfer out per tip, and one back: never a second send.
  assert.equal(state.inGroup(moved.key), 1);
  assert.equal(state.inGroup(unmoved.key), 0);
  assert.equal(state.backs.length, 1);
  assert.equal(await available(TOBI), 0n);
  assert.equal(await available(ADA), 0n);
});

test('the held amount comes off what they can withdraw, and nothing else', async () => {
  await verified(TOBI);
  const { provider } = partner();
  const disputed = await movedTip(TOBI, provider);
  await movedTip(TOBI, provider);
  assert.equal(await available(TOBI), 2n * NET);
  await apply(disputeEvent(disputed));
  // Only the disputed tip's share is held; the other tip is still theirs to withdraw.
  // (balanceIn is what a withdrawal checks, under the profile lock.)
  assert.equal(await available(TOBI), NET);
  await apply(
    disputeEvent(disputed, {
      eventType: 'dispute.updated',
      status: 'won',
      occurredAt: at(2 * HOUR),
    }),
    at(2 * HOUR),
  );
  assert.equal(await available(TOBI), 2n * NET);
});

test('the database refuses to cancel a share that may have been sent (P27)', async () => {
  await verified(TOBI);
  const { provider, state } = partner();
  const tip = await paidTip(TOBI);
  await release(T0);
  state.answers.push('lost');
  await run(provider, T0);
  const share = await shareOf(tip.rowId);
  assert.equal(share.status, 'unknown');
  assert.ok(share.sent_at);
  await assert.rejects(
    q(`UPDATE collect_transfers SET status = 'cancelled' WHERE id = $1`, [
      tip.rowId,
    ]),
    /collect_transfers_never_cancel_sent/,
  );
  // The shared guard every dispute and refund hook uses says no, and moves nothing.
  for (const to of ['cancelled', 'review'])
    assert.equal(
      await database.db.transaction((tx) =>
        ops.takeUnsentShare(tx, {
          transferId: tip.rowId,
          to,
          reviewReason: 'dispute',
          now: at(HOUR),
        }),
      ),
      false,
    );
  assert.equal((await shareOf(tip.rowId)).status, 'unknown');
});

test('a transfer back refused for the recipient’s debt goes to review with an issue, and stops nothing else (P14)', async () => {
  await verified(TOBI);
  await verified(ADA);
  const { provider, state } = partner();
  const tip = await movedTip(TOBI, provider);
  await apply(disputeEvent(tip));
  await apply(
    disputeEvent(tip, {
      eventType: 'dispute.updated',
      status: 'lost',
      occurredAt: at(2 * HOUR),
    }),
    at(2 * HOUR),
  );
  const other = await paidTip(ADA, at(2 * HOUR));
  await release(at(2 * HOUR));
  // As the recipient's account, ORGANIZATION_IN_DEBT is THEIR debt, not TipMe's.
  state.backAnswers.push({ reject: 'in_debt', code: 'ORGANIZATION_IN_DEBT' });
  const result = await run(provider, at(3 * HOUR));
  assert.equal(result.stopped, undefined);
  const [back] = await q(
    `SELECT id, status, review_reason FROM collect_transfers WHERE kind = 'back'`,
  );
  assert.equal(back.status, 'review');
  assert.equal(back.review_reason, 'provider');
  assert.deepEqual(
    (await issuesOf('collect_transfer_review')).map((i) => i.dedupe_key),
    [`collect_transfer_review.${back.id}`],
  );
  assert.deepEqual(await issuesOf('collect_in_debt'), []);
  // Ada's share still moved in the same run.
  assert.equal((await shareOf(other.rowId)).status, 'paid');
  // The dispute waits, its hold kept, nothing posted.
  const row = await disputeOf(tip.disputeRef);
  assert.equal(row.settled_at, null);
  assert.equal(row.held, String(NET));
  assert.equal(
    await ops.settleLostDispute(database.db, {
      disputeId: row.id,
      now: at(4 * HOUR),
    }),
    'waiting_back',
  );
  assert.deepEqual(await linesOf(`dispute_loss.${row.id}`), []);
});

test('a dispute closed before any ruling books no loss and keeps the share held for the refund', async () => {
  const tip = await paidTip(TOBI);
  await apply(disputeEvent(tip));
  // `prevented` (and `closed`) arrive as closed: the refund event books that money (Task 10).
  assert.equal(
    (
      await apply(
        disputeEvent(tip, {
          eventType: 'dispute.updated',
          status: 'closed',
          occurredAt: at(2 * HOUR),
        }),
        at(2 * HOUR),
      )
    ).outcome,
    'updated',
  );
  const row = await disputeOf(tip.disputeRef);
  assert.equal(row.status, 'closed');
  assert.ok(row.settled_at);
  assert.deepEqual(await linesOf(`dispute_loss.${row.id}`), []);
  // Not released to the recipient: a refund would then pay the same money twice.
  const share = await shareOf(tip.rowId);
  assert.equal(share.status, 'review');
  assert.equal(share.review_reason, 'refund');
  assert.deepEqual(
    (await issuesOf('collect_transfer_review')).map((i) => i.dedupe_key),
    [`dispute_closed.${row.id}`],
  );
  // A sweep changes nothing more.
  await steps(at(3 * HOUR));
  assert.equal((await shareOf(tip.rowId)).review_reason, 'refund');
});

test('a deadline reminder opens 48 hours before the response is due, once', async () => {
  const tip = await paidTip(TOBI);
  await apply(disputeEvent(tip, { respondBy: at(3 * DAY) }));
  await steps(at(HOUR));
  assert.deepEqual(await issuesOf('dispute_deadline'), []);
  await steps(at(DAY + 2 * HOUR));
  await steps(at(DAY + 3 * HOUR));
  const row = await disputeOf(tip.disputeRef);
  assert.deepEqual(
    (await issuesOf('dispute_deadline')).map((i) => i.dedupe_key),
    [`dispute_deadline.${row.id}`],
  );
});
