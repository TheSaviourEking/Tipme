import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import {
  ProRefundRefusedError,
  PayoutRejectedError,
  UncertainProviderOutcomeError,
} from '../../packages/payments/dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
} from '../../packages/database/test/integration/business-fixtures.mjs';
import * as contracts from '../../packages/contracts/dist/index.js';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY, setSwitch } from './helpers.mjs';

/*
 * You collect (plan Task 10, spec §6.1, P7, P26–P30, P28, R6): a collect tip was charged to TipMe's
 * own account, so its refund comes out of TipMe's balance (`refundPlatformCharge`), and TipMe
 * recovers the recipient's part first. A share still held is held for the refund when it is asked
 * for, cancelled only once the refund is paid, and let go if the refund fails. A share that moved
 * and is still in their balance is taken back first (a `back` transfer), then refunded. A share
 * they withdrew stops for staff: going ahead is a second person's decision, and TipMe absorbs the
 * gap. The supporter always gets the tip minus TipMe's fee. No partner is called: fakes answer.
 */

const key = Buffer.from(OPS_TOTP_KEY, 'base64');
const sealing = ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64'));
const REASON =
  'The supporter paid twice by mistake and asked us to refund one.';
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
const people = new Map();
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
  ops.registerRealSeriousActions();
});
after(async () => {
  await setSwitch(database.pool, 'you_collect', false);
  await database.close();
});
beforeEach(async () => {
  await database.reset();
  people.clear();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  await setSwitch(database.pool, 'you_collect', true);
  await setSwitch(database.pool, 'tip_refunds', true);
  await q(`UPDATE profiles SET created_at = $1`, [at(-30 * DAY)]);
});

/* Staff: two owners, so every serious action waits for the other. */

async function person() {
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`collectrefund.${randomUUID().slice(0, 8)}@example.com`],
  );
  await q(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'owner', now(), now())`,
    [id],
  );
  const secret = newTotpSecret();
  await q(
    `INSERT INTO staff_totp (user_id, secret_enc, confirmed_at) VALUES ($1, $2, now())`,
    [id, ops.sealSecret(key, secret)],
  );
  const [{ id: sessionId }] = await q(
    `INSERT INTO sessions (id, user_id, token_sha256, created_at, last_seen_at, expires_at)
     VALUES (gen_random_uuid(), $1, $2, now(), now(), now() + interval '1 day') RETURNING id`,
    [id, randomBytes(32).toString('hex')],
  );
  const [{ id: grantId }] = await q(
    `INSERT INTO ops_sessions (id, user_id, session_id, token_sha256, created_at, last_seen_at, expires_at, last_totp_at)
     VALUES (gen_random_uuid(), $1, $2, $3, now(), now(), now() + interval '1 hour', now()) RETURNING id`,
    [id, sessionId, randomBytes(32).toString('hex')],
  );
  people.set(id, { secret, grantId });
  return id;
}
const services = () => ({
  sealing,
  authCodeSecret: 'test-auth-code-secret-of-enough-length',
});
const ask = (actorId, tipId, name = 'tip.refund') =>
  ops.requestSeriousAction(database.db, {
    name,
    payload: { tipId },
    actorId,
    grantId: people.get(actorId).grantId,
    reason: REASON,
    services: services(),
  });
const approve = (requestId, actorId) =>
  ops.approveRequest(database.db, {
    requestId,
    actorId,
    code: totpAt(
      people.get(actorId).secret,
      BigInt(Math.floor(Date.now() / 30_000)),
    ),
    key,
    services: services(),
  });
const refundRow = async (tipId) =>
  (
    await q(
      `SELECT id, status, failure, collect_plan, gap_minor::text AS gap, held_minor::text AS held,
              amount_minor::text AS amount
         FROM tip_refunds WHERE tip_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [tipId],
    )
  )[0];
/** Asked by one owner, approved by another: the refund recorded (nothing sent yet). */
async function refundAsked(tipId, name = 'tip.refund') {
  const requester = await person();
  const approver = await person();
  const outcome = await ask(requester, tipId, name);
  assert.equal(outcome.state, 'pending', JSON.stringify(outcome));
  const approved = await approve(outcome.requestId, approver);
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  return refundRow(tipId);
}

/* Collect tips (Task 7), as the dispute tests make them. */

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

async function paidTip(profile, settledAt = T0, { shared } = {}) {
  const { db } = database;
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    profile.id,
  ]);
  const sharing = shared
    ? { businessMemberId: shared.memberId, sharesOn: true }
    : {};
  const quote = await ops.createQuote(db, {
    handle: profile.handle,
    tipMinor: GROSS,
    currency: 'NGN',
    ...sharing,
  });
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    ...sharing,
  });
  const providerReference = `platform:cs_${randomUUID().slice(0, 8)}`;
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference,
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
    rowId: row?.id ?? null,
    providerReference,
    chargeReference,
    disputeRef: `dp_${randomUUID().slice(0, 10)}`,
  };
}

/** The partner's side of collect transfers: shares out of TipMe's balance and transfers back in. */
function partner() {
  const state = {
    sends: [],
    backs: [],
    listed: [],
    answers: [],
    backAnswers: [],
  };
  const movedTo = (input) => {
    let transfer = state.listed.find((t) => t.group === input.idempotencyKey);
    if (!transfer) {
      transfer = {
        transferRef: `tr_${state.listed.length + 1}`,
        status: 'paid',
        amountMinor: input.amountMinor,
        currency: input.currency,
        group: input.idempotencyKey,
        accountRef: input.accountRef,
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
      const transfer = movedTo(input);
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
      const transfer = movedTo(input);
      return { transferRef: transfer.transferRef, status: 'paid' };
    },
    async listAccountTransfers(accountRef) {
      return state.listed
        .filter((t) => t.accountRef === accountRef)
        .map((t) => ({
          transferRef: t.transferRef,
          status: t.status,
          amountMinor: t.amountMinor,
          currency: t.currency,
          group: t.group,
        }));
    },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
  };
  return { provider, state };
}
const release = (now) => ops.releaseWaitingTransfers(database.db, { now });
const run = (provider, now) =>
  ops.runCollectTransfers(database.db, { provider, now });
async function movedTip(profile, provider) {
  const tip = await paidTip(profile);
  await release(T0);
  await run(provider, T0);
  assert.equal((await shareOf(tip.rowId)).status, 'paid');
  return tip;
}

/** TipMe's own account at the partner: refunds out of its balance, and how a tip was paid. */
function refunder() {
  const state = {
    refunds: [],
    method: 'NGN_CARD',
    /** A 400 from the partner, with its code (null: none). */
    refuse: null,
    lost: false,
    /** The request never left (a connection error before sending). */
    notSent: false,
    /** TipMe's available naira (null: it can't be read). */
    balance: null,
  };
  const provider = {
    async refundAccountCharge() {
      throw new Error('a collect tip is never refunded as the recipient');
    },
    async refundPlatformCharge(input) {
      state.refunds.push({ ...input });
      if (state.notSent) {
        const error = new Error('connection refused before sending');
        error.name = 'BachsRequestNotSentError';
        throw error;
      }
      if (state.refuse) throw new ProRefundRefusedError(state.refuse);
      if (state.lost)
        throw new UncertainProviderOutcomeError(input.reference, 'no answer', {
          cause: 'no_response',
        });
      return {
        refundReference: `rf_${state.refunds.length}`,
        status: 'processing',
      };
    },
    async verifyTransaction() {
      return {
        status: 'succeeded',
        amountMinor: GROSS,
        currency: 'NGN',
        feeMinor: 20_000n,
        feePaidBy: 'platform',
        method: state.method,
      };
    },
    async platformBalances() {
      if (state.balance === null) throw new Error('unreadable');
      return [
        { currency: 'NGN', availableMinor: state.balance, pendingMinor: 0n },
      ];
    },
  };
  return { provider, state };
}
const send = (provider, now = new Date()) =>
  ops.sendTipRefunds(database.db, { provider, providerName: 'bachs', now });
const paid = (refundId, over = {}) =>
  ops.applyTipRefundEvent(database.db, {
    tipRefundId: refundId,
    refundState: 'paid',
    partnerReversalId: 'refund.rf_1',
    refundedMinor: NET,
    refundFeeMinor: 0n,
    now: new Date(),
    ...over,
  });

const shareOf = async (rowId) =>
  (
    await q(
      `SELECT status, review_reason, account_reference, sent_at, amount_minor::text AS amount
         FROM collect_transfers WHERE id = $1`,
      [rowId],
    )
  )[0];
const backsOf = (refundId) =>
  q(
    `SELECT id, status, amount_minor::text AS amount, account_reference, idempotency_key
       FROM collect_transfers WHERE kind = 'back' AND refund_id = $1`,
    [refundId],
  );
/** A ledger transaction's lines, owner-labelled. */
const linesOf = (operationKey) =>
  q(
    `SELECT a.code, CASE WHEN a.profile_id IS NOT NULL THEN 'person'
                         WHEN a.business_id IS NOT NULL THEN 'business' ELSE 'tipme' END AS owner,
            e.side::text AS side, e.amount_minor::text AS amount
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.operation_key = $1 ORDER BY a.code, owner, e.side`,
    [operationKey],
  );
const refundKey = (refundId) => `collect_refund.${refundId}`;
const reversalsOf = (tipId) =>
  q(
    `SELECT operation_key FROM ledger_transactions WHERE tip_id = $1 AND operation_type = 'reversal'`,
    [tipId],
  );
const available = async (profile) =>
  (await ops.balanceOf(database.db, profile.id)).availableMinor;
const withdrawing = (profile, amountMinor) =>
  q(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint)
     VALUES ($1, $2, 'NGN', $3, 'REQUESTED', $4, 'test')`,
    [randomUUID(), profile.id, amountMinor, randomUUID()],
  );
const facts = (tipId, read) => ops.tipRefundFacts(database.db, tipId, read);
const line = (code, owner, side, amount) => ({
  code,
  owner,
  side,
  amount: String(amount),
});

test("a held share is cancelled and the refund comes from TipMe's balance", async () => {
  // No bank details yet: the share is still in TipMe's balance.
  const tip = await paidTip(TOBI);
  const seen = await facts(tip.tipId);
  assert.equal(seen.refundable, true);
  assert.equal(seen.refundMinor, NET);
  assert.deepEqual(seen.collect, { plan: 'cancel_held', gapMinor: 0n });

  const refund = await refundAsked(tip.tipId);
  assert.equal(refund.status, 'REQUESTED');
  assert.equal(refund.collect_plan, 'cancel_held');
  assert.equal(refund.amount, String(NET));
  // P7: held for the refund, never cancelled before the money has gone back.
  const held = await shareOf(tip.rowId);
  assert.equal(held.status, 'review');
  assert.equal(held.review_reason, 'refund');
  // And not something they can withdraw meanwhile.
  assert.equal(await available(TOBI), 0n);

  const { provider, state } = refunder();
  assert.deepEqual(await send(provider), { sent: 1, failed: 0 });
  assert.deepEqual(state.refunds, [
    {
      chargeReference: tip.chargeReference,
      amountMinor: NET,
      reference: `tipme-tip-refund-${refund.id}`,
      idempotencyKey: `tipme-tip-refund-${refund.id}`,
    },
  ]);
  assert.equal((await refundRow(tip.tipId)).status, 'PROCESSING');
  assert.equal((await shareOf(tip.rowId)).status, 'review');
  assert.deepEqual(await reversalsOf(tip.tipId), []);

  assert.equal(await paid(refund.id), 'refunded');
  assert.equal(await paid(refund.id), 'already');
  assert.equal((await shareOf(tip.rowId)).status, 'cancelled');
  assert.equal((await refundRow(tip.tipId)).status, 'PAID');
  // The recipient gives back what they received; TipMe keeps its fee and pays from its balance.
  assert.deepEqual(await linesOf(refundKey(refund.id)), [
    line('held_for_recipients', 'person', 'credit', NET),
    line('recipient_payable', 'person', 'debit', NET),
  ]);
  assert.deepEqual(await reversalsOf(tip.tipId), [
    { operation_key: refundKey(refund.id) },
  ]);
  assert.equal(await available(TOBI), 0n);
  // Sent once: a later run asks nothing more.
  await send(provider);
  assert.equal(state.refunds.length, 1);
});

test('a moved share still in their balance is taken back first, then refunded', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  assert.equal(await available(TOBI), NET);
  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'take_back',
    gapMinor: 0n,
  });
  const refund = await refundAsked(tip.tipId);
  assert.equal(refund.collect_plan, 'take_back');
  assert.equal(refund.held, String(NET));
  assert.equal(await available(TOBI), 0n);

  const { provider, state } = refunder();
  state.balance = 100_000_000n;
  // First the money comes back from their account; nothing is refunded until it has.
  assert.deepEqual(await send(provider), { sent: 0, failed: 0 });
  assert.deepEqual(state.refunds, []);
  const [back] = await backsOf(refund.id);
  assert.deepEqual(
    { ...back, id: undefined },
    {
      id: undefined,
      status: 'ready',
      amount: String(NET),
      account_reference: ACCOUNTS[TOBI.id],
      idempotency_key: `tipme-collect-back-${refund.id}`,
    },
  );
  await run(transfers, new Date());
  assert.deepEqual(moves.backs, [
    {
      accountRef: ACCOUNTS[TOBI.id],
      amountMinor: NET,
      currency: 'NGN',
      idempotencyKey: `tipme-collect-back-${refund.id}`,
    },
  ]);
  assert.equal((await backsOf(refund.id))[0].status, 'paid');
  assert.deepEqual(await send(provider), { sent: 1, failed: 0 });
  assert.equal(state.refunds.length, 1);
  assert.equal(await paid(refund.id), 'refunded');
  assert.deepEqual(await linesOf(refundKey(refund.id)), [
    line('held_for_recipients', 'person', 'credit', NET),
    line('recipient_payable', 'person', 'debit', NET),
  ]);
  // Taken back once, refunded once; the share itself was never touched.
  await run(transfers, new Date());
  await send(provider);
  assert.equal(moves.backs.length, 1);
  assert.equal(state.refunds.length, 1);
  assert.equal((await shareOf(tip.rowId)).status, 'paid');
  assert.equal(await available(TOBI), 0n);
});

test("a withdrawn share stops for staff; going ahead needs a second person and books the gap as TipMe's", async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  // ₦6,500 of it is on its way to their bank: ₦3,000 is still there to take back.
  await withdrawing(TOBI, 650_000n);
  const seen = await facts(tip.tipId);
  assert.equal(seen.refundable, true);
  assert.deepEqual(seen.collect, { plan: 'staff_decides', gapMinor: 650_000n });

  // The plain refund can't go ahead: it would have TipMe absorb money nobody decided to.
  const requester = await person();
  const approver = await person();
  await assert.rejects(ask(requester, tip.tipId), {
    code: 'TIP_REFUND_REFUSED',
    detail: 'staff_decides',
  });
  assert.deepEqual(
    await q(`SELECT 1 FROM tip_refunds WHERE tip_id = $1`, [tip.tipId]),
    [],
  );

  // Going ahead is its own serious action: a second person decides, never the one who asked.
  const absorb = await ask(requester, tip.tipId, 'tip_refund.absorb_gap');
  assert.equal(absorb.state, 'pending');
  const [request] = await q(
    `SELECT summary FROM approval_requests WHERE id = $1`,
    [absorb.requestId],
  );
  assert.match(request.summary, /NGN 6,500\.00/);
  await assert.rejects(approve(absorb.requestId, requester), {
    code: 'APPROVAL_OWN_REQUEST',
  });
  assert.equal((await approve(absorb.requestId, approver)).status, 'approved');
  const refund = await refundRow(tip.tipId);
  assert.equal(refund.collect_plan, 'absorb');
  assert.equal(refund.gap, '650000');
  assert.equal(refund.held, '300000');

  const { provider, state } = refunder();
  state.balance = 100_000_000n;
  await send(provider);
  assert.deepEqual(state.refunds, []);
  await run(transfers, new Date());
  assert.deepEqual(
    moves.backs.map((b) => b.amountMinor),
    [300_000n],
  );
  await send(provider);
  assert.equal(state.refunds.length, 1);
  assert.equal(state.refunds[0].amountMinor, NET);
  assert.equal(await paid(refund.id), 'refunded');
  // What came back is theirs to give back; the gap is TipMe's loss (R6).
  assert.deepEqual(await linesOf(refundKey(refund.id)), [
    line('held_for_recipients', 'person', 'credit', 300_000n),
    line('platform_clearing', 'tipme', 'credit', 650_000n),
    line('recipient_payable', 'person', 'debit', 300_000n),
    line('refund_loss_expense', 'tipme', 'debit', 650_000n),
  ]);
});

test('a refund refused for low balance moves nothing and says why', async () => {
  const tip = await paidTip(TOBI);
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  state.refuse = 'INSUFFICIENT_BALANCE';
  assert.deepEqual(await send(provider), { sent: 0, failed: 1 });
  const failed = await refundRow(tip.tipId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failure, 'balance');
  assert.equal(failed.held, '0');
  // P7: the share is let go again, as it was, and nothing was booked.
  const share = await shareOf(tip.rowId);
  assert.equal(share.status, 'waiting');
  assert.equal(share.review_reason, null);
  assert.deepEqual(await reversalsOf(tip.tipId), []);
  // Back with TipMe, kept for them as before (Task 12: not withdrawable until they verify).
  assert.equal((await ops.balanceOf(database.db, TOBI.id)).keptMinor, NET);
  const seen = await facts(tip.tipId);
  assert.equal(seen.refundable, true);
  assert.equal(
    seen.lastFailure,
    "TipMe's balance can't cover this refund right now.",
  );
  const [issue] = await q(
    `SELECT summary AS note FROM issues WHERE dedupe_key = $1`,
    [`tip_refund_failed.${refund.id}`],
  );
  assert.match(issue.note, /TipMe's balance can't cover this refund right now/);

  // A moved share with TipMe's balance read too low: nothing is taken back from them either.
  await verified(ADA);
  const { provider: transfers, state: moves } = partner();
  const moved = await movedTip(ADA, transfers);
  const second = await refundAsked(moved.tipId);
  state.refuse = null;
  state.balance = NET - 1n;
  await send(provider);
  assert.equal((await refundRow(moved.tipId)).failure, 'balance');
  // Its transfer back was recorded, waiting, and is cancelled without ever being released.
  assert.deepEqual(
    (await backsOf(second.id)).map((b) => b.status),
    ['cancelled'],
  );
  await run(transfers, new Date());
  assert.deepEqual(moves.backs, []);
  assert.equal(await available(ADA), NET);
  assert.equal(state.refunds.length, 1);
});

test('a bank-transfer collect tip is not refundable', async () => {
  const tip = await paidTip(TOBI);
  // Read before anyone asks (the API reads how it was paid from TipMe's own account).
  const seen = await facts(tip.tipId, { method: 'bank_transfer' });
  assert.equal(seen.refundable, false);
  assert.equal(seen.refusal, 'bank_transfer');
  // Asked anyway (the read failed then): the worker reads it again before anything moves.
  await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  state.method = 'NGN_BANK_TRANSFER';
  await send(provider);
  const failed = await refundRow(tip.tipId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failure, 'bank_transfer');
  assert.deepEqual(state.refunds, []);
  assert.equal((await shareOf(tip.rowId)).status, 'waiting');
  assert.equal((await facts(tip.tipId)).refusal, 'bank_transfer');
});

test('a refund during an in-flight transfer waits for the read-back and recovers exactly once', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await paidTip(TOBI);
  await release(T0);
  // The partner moved it, but its answer was lost: the share may have moved.
  moves.answers.push('lost');
  await run(transfers, T0);
  assert.equal((await shareOf(tip.rowId)).status, 'unknown');
  const seen = await facts(tip.tipId);
  assert.equal(seen.refundable, false);
  assert.equal(seen.refusal, 'in_flight');
  assert.equal(
    seen.words,
    "This tip's share is moving to the recipient right now. Try again in a few minutes.",
  );
  assert.equal(seen.collect.plan, 'wait');
  // Nothing is held, cancelled or recorded under a transfer that may land.
  const staffUserId = await person();
  await assert.rejects(
    database.db.transaction((tx) =>
      ops.askTipRefund(tx, {
        tipId: tip.tipId,
        staffUserId,
        approvedBy: null,
        reason: REASON,
        now: new Date(),
      }),
    ),
    { code: 'TIP_REFUND_REFUSED' },
  );
  assert.equal((await shareOf(tip.rowId)).status, 'unknown');

  // The read-back finds it moved: now it is taken back, once.
  await run(transfers, new Date(T0.getTime() + 25 * HOUR));
  assert.equal((await shareOf(tip.rowId)).status, 'paid');
  assert.equal(moves.sends.length, 1);
  const refund = await refundAsked(tip.tipId);
  assert.equal(refund.collect_plan, 'take_back');
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  await send(provider);
  await run(transfers, new Date());
  await send(provider);
  assert.equal(await paid(refund.id), 'refunded');
  assert.equal(await paid(refund.id), 'already');
  assert.equal(moves.sends.length, 1);
  assert.equal(moves.backs.length, 1);
  assert.equal(state.refunds.length, 1);
  assert.equal((await reversalsOf(tip.tipId)).length, 1);
});

test("a direct tip's refund is unchanged", async () => {
  // The direct path is unchanged (tip-refund.test.mjs): no collect plan, refundAccountCharge.
  await q(`UPDATE profiles SET collection_mode = 'direct' WHERE id = $1`, [
    TOBI.id,
  ]);
  const quote = await ops.createQuote(database.db, {
    handle: 'tobi',
    tipMinor: GROSS,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `mock_pay_${randomUUID()}`;
  await ops.markAttemptInitiated(database.db, {
    attemptId: intent.attemptId,
    provider: 'mock',
    providerReference: reference,
  });
  await ops.recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: `evt_${randomUUID()}`,
    eventType: 'payment.succeeded',
    attemptId: intent.attemptId,
    providerReference: reference,
    amountMinor: GROSS,
    currency: 'NGN',
    providerFeeMinor: 20000n,
    signatureVerified: true,
    payload: {},
  });
  assert.equal((await facts(intent.tipId)).collect, null);
  const refund = await refundAsked(intent.tipId);
  assert.equal(refund.collect_plan, null);
  const calls = [];
  await ops.sendTipRefunds(database.db, {
    provider: {
      async refundAccountCharge(input) {
        calls.push(['account', input.providerReference]);
        return { refundReference: 'rf_d', status: 'processing' };
      },
      async refundPlatformCharge() {
        calls.push(['platform']);
        throw new Error('never');
      },
    },
    providerName: 'mock',
    now: new Date(),
  });
  assert.deepEqual(calls, [['account', reference]]);
});

test('a closed dispute’s hold is consumed by the refund: released once, never recovered twice (P28)', async () => {
  const tip = await paidTip(TOBI);
  const dispute = (status, n) => ({
    kind: 'dispute',
    eventId: `evt_${randomUUID()}`,
    eventType: n === 1 ? 'dispute.created' : 'dispute.updated',
    scope: 'platform',
    partnerDisputeId: tip.disputeRef,
    chargeReference: tip.chargeReference,
    providerReference: null,
    operationReference: null,
    status,
    amountMinor: GROSS,
    currency: 'NGN',
    reason: 'fraudulent',
    respondBy: at(7 * DAY),
    feeMinor: null,
    feeCurrency: null,
    occurredAt: at(n * HOUR),
  });
  const apply = (event, now) =>
    ops.applyDisputeEvent(database.db, { event, provider: 'bachs', now });
  await apply(dispute('open', 1), at(HOUR));
  // While it is open the tip can't be refunded from here: it would be returned twice.
  assert.equal((await facts(tip.tipId)).refusal, 'disputed');
  await apply(dispute('closed', 2), at(2 * HOUR));
  const [closed] = await q(
    `SELECT id, settled_at FROM disputes WHERE partner_dispute_id = $1`,
    [tip.disputeRef],
  );
  assert.equal(closed.settled_at, null);
  assert.equal((await shareOf(tip.rowId)).review_reason, 'refund');

  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'cancel_held',
    gapMinor: 0n,
  });
  const refund = await refundAsked(tip.tipId);
  const { provider } = refunder();
  await send(provider);
  assert.equal(await paid(refund.id), 'refunded');
  const [settled] = await q(
    `SELECT held_minor::text AS held, settled_at FROM disputes WHERE id = $1`,
    [closed.id],
  );
  assert.equal(settled.held, '0');
  assert.ok(settled.settled_at);
  assert.equal((await shareOf(tip.rowId)).status, 'cancelled');
  // Fifteen days on, the dispute's own release finds nothing left to do.
  await ops.runDisputeSteps(database.db, { now: at(15 * DAY) });
  assert.equal((await shareOf(tip.rowId)).status, 'cancelled');
  assert.deepEqual(await reversalsOf(tip.tipId), [
    { operation_key: refundKey(refund.id) },
  ]);
  assert.deepEqual(await linesOf(`dispute_loss.${closed.id}`), []);
  assert.equal(await available(TOBI), 0n);
});

test('a closed dispute’s hold on a moved share is taken back once by the refund (P28)', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  await ops.applyDisputeEvent(database.db, {
    event: {
      kind: 'dispute',
      eventId: `evt_${randomUUID()}`,
      eventType: 'dispute.updated',
      scope: 'platform',
      partnerDisputeId: tip.disputeRef,
      chargeReference: tip.chargeReference,
      providerReference: null,
      operationReference: null,
      status: 'closed',
      amountMinor: GROSS,
      currency: 'NGN',
      reason: null,
      respondBy: null,
      feeMinor: null,
      feeCurrency: null,
      occurredAt: at(HOUR),
    },
    provider: 'bachs',
    now: at(HOUR),
  });
  // The dispute holds the whole share of their balance; the refund takes that back.
  assert.equal(await available(TOBI), 0n);
  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'take_back',
    gapMinor: 0n,
  });
  const refund = await refundAsked(tip.tipId);
  // Held once, not twice: the dispute's hold covers it.
  assert.equal(refund.held, '0');
  const { provider } = refunder();
  await send(provider);
  await run(transfers, new Date());
  await send(provider);
  assert.equal(await paid(refund.id), 'refunded');
  const [settled] = await q(
    `SELECT held_minor::text AS held, settled_at FROM disputes WHERE partner_dispute_id = $1`,
    [tip.disputeRef],
  );
  assert.equal(settled.held, '0');
  assert.ok(settled.settled_at);
  assert.equal(moves.backs.length, 1);
  assert.equal(await available(TOBI), 0n);
  await ops.runDisputeSteps(database.db, { now: at(15 * DAY) });
  assert.equal(await available(TOBI), 0n);
});

/** A collect tip to Tobi with a 20% business share (R3). */
async function sharedTip() {
  await setSwitch(database.pool, 'business', true);
  await setSwitch(database.pool, 'business_shares', true);
  const { businessId, locations } = await seedBusiness(database);
  const { memberId } = await seedMember(database, {
    locationId: locations[0].id,
    profileId: TOBI.id,
  });
  await seedAgreement(database, { memberId, businessBps: 2000 });
  const tip = await paidTip(TOBI, T0, { shared: { memberId } });
  const [{ share }] = await q(
    `SELECT share_minor::text AS share FROM tip_business_shares WHERE tip_id = $1`,
    [tip.tipId],
  );
  return { tip, businessId, share: BigInt(share) };
}
const sweepOf = async (tipId) =>
  (
    await q(
      `SELECT status, amount_minor::text AS amount FROM share_transfers
        WHERE tip_id = $1 AND kind = 'collect_sweep'`,
      [tipId],
    )
  )[0];
function businessPartner() {
  const sent = [];
  const pulled = [];
  const state = { balance: null };
  return {
    sent,
    pulled,
    state,
    provider: {
      name: 'bachs-sandbox',
      capabilities: { connectedAccounts: false },
      async collectToPlatform(input) {
        pulled.push([
          input.accountRef,
          input.amountMinor,
          input.idempotencyKey,
        ]);
        return { transferRef: `tr_p${pulled.length}`, status: 'paid' };
      },
      async payoutBalance() {
        return { availableMinor: state.balance ?? 100_000_000n };
      },
      async transferToAccount(input) {
        sent.push(input.amountMinor);
        return { transferRef: `tr_b${sent.length}`, status: 'paid' };
      },
      async findPlatformCollection() {
        return null;
      },
    },
  };
}
const sweep = (provider) =>
  ops.runShareTransfers(database.db, {
    provider,
    now: new Date(Date.now() + 2 * HOUR),
    settleWaitMs: HOUR,
  });

test('a business share still held is taken from TipMe’s balance with the refund, and never swept after', async () => {
  const { tip, businessId, share } = await sharedTip();
  const refund = await refundAsked(tip.tipId);
  assert.equal(refund.collect_plan, 'cancel_held');
  // Not swept while the refund is open.
  const business = businessPartner();
  await sweep(business.provider);
  assert.deepEqual(business.sent, []);
  const { provider } = refunder();
  await send(provider);
  assert.equal(await paid(refund.id), 'refunded');
  assert.equal((await sweepOf(tip.tipId)).status, 'cancelled');
  assert.deepEqual(await linesOf(refundKey(refund.id)), [
    line('business_payable', 'business', 'debit', share),
    line('held_for_recipients', 'business', 'credit', share),
    line('held_for_recipients', 'person', 'credit', NET - share),
    line('recipient_payable', 'person', 'debit', NET - share),
  ]);
  await sweep(business.provider);
  assert.deepEqual(business.sent, []);
  assert.ok(businessId);
});

test('a business share already swept is pulled back once before the refund; TipMe absorbs only what it can’t get back', async () => {
  const { tip, businessId, share } = await sharedTip();
  const business = businessPartner();
  await sweep(business.provider);
  assert.deepEqual(business.sent, [share]);
  // The business's share moved: it is pulled back first, and nobody is asked to absorb anything yet.
  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'take_back',
    gapMinor: 0n,
  });
  const first = await refundAsked(tip.tipId);
  assert.equal(first.collect_plan, 'take_back');
  const { provider, state } = refunder();
  await send(provider);
  assert.deepEqual(state.refunds, []);
  // Only half of it is still in the business's account.
  business.state.balance = share / 2n;
  await sweep(business.provider);
  assert.equal(business.pulled.length, 1);
  assert.equal(business.pulled[0][0], businessId);
  assert.equal(business.pulled[0][1], share / 2n);
  // Nobody decided TipMe absorbs the rest: nothing is refunded; what came back is kept for the refund.
  await send(provider);
  assert.deepEqual(state.refunds, []);
  assert.equal((await refundRow(tip.tipId)).failure, 'not_recovered');
  // Now the gap is known: what the pull-back couldn't find.
  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'staff_decides',
    gapMinor: share - share / 2n,
  });
  const refund = await refundAsked(tip.tipId, 'tip_refund.absorb_gap');
  assert.equal(refund.collect_plan, 'absorb');
  await sweep(business.provider);
  await send(provider);
  assert.equal(state.refunds.length, 1);
  // Pulled back once, for both asks.
  assert.equal(business.pulled.length, 1);
  assert.equal(await paid(refund.id), 'refunded');
  assert.deepEqual(await linesOf(refundKey(refund.id)), [
    line('business_payable', 'business', 'debit', share / 2n),
    line('held_for_recipients', 'business', 'credit', share / 2n),
    line('held_for_recipients', 'person', 'credit', NET - share),
    line('platform_clearing', 'tipme', 'credit', share - share / 2n),
    line('recipient_payable', 'person', 'debit', NET - share),
    line('refund_loss_expense', 'tipme', 'debit', share - share / 2n),
  ]);
  await sweep(business.provider);
  assert.equal(business.pulled.length, 1);
});

test('with the switch off, an existing collect tip is still refunded from TipMe’s balance', async () => {
  const tip = await paidTip(TOBI);
  // §12.5: switching off stops new collect sign-ups, never the money already held.
  await setSwitch(database.pool, 'you_collect', false);
  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'cancel_held',
    gapMinor: 0n,
  });
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  assert.equal(state.refunds.length, 1);
  assert.equal(await paid(refund.id), 'refunded');
  assert.equal((await shareOf(tip.rowId)).status, 'cancelled');
});

test('a transfer back that is refused fails the refund with nothing moved', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  moves.backAnswers.push({
    reject: 'insufficient',
    code: 'INSUFFICIENT_BALANCE',
  });
  await run(transfers, new Date());
  await send(provider);
  const failed = await refundRow(tip.tipId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.held, '0');
  assert.deepEqual(state.refunds, []);
  assert.equal((await backsOf(refund.id))[0].status, 'cancelled');
  assert.equal(await available(TOBI), NET);
  assert.deepEqual(await reversalsOf(tip.tipId), []);
});

/* Fix round 1 (review C1, I1, I2, M1). */

const allBacks = (tipId) =>
  q(
    `SELECT amount_minor::text AS amount, status FROM collect_transfers
      WHERE tip_id = $1 AND kind = 'back' ORDER BY created_at`,
    [tipId],
  );

test('a refund refused after its part was taken back keeps that money for the next ask, which takes nothing twice', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  const other = await movedTip(TOBI, transfers);
  assert.ok(other);
  assert.equal(await available(TOBI), 2n * NET);
  const first = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  assert.equal(moves.backs.length, 1);
  // The partner refuses the refund after the ₦9,500 is back with TipMe.
  state.refuse = 'INSUFFICIENT_BALANCE';
  await send(provider);
  const failed = await refundRow(tip.tipId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failure, 'balance');
  // That money is with TipMe now, kept for this tip's refund: the other tip is theirs in full.
  assert.equal(await available(TOBI), NET);
  assert.match(
    (
      await q(`SELECT summary FROM issues WHERE dedupe_key = $1`, [
        `tip_refund_failed.${first.id}`,
      ])
    )[0].summary,
    /₦9,500 .*kept for this tip's refund/,
  );
  // Asked again: what came back is used, nothing is taken from them a second time.
  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'take_back',
    gapMinor: 0n,
  });
  const second = await refundAsked(tip.tipId);
  // The money is already back with TipMe (held_for_recipients): nothing more to reserve.
  assert.equal(second.held, '0');
  assert.equal((await facts(tip.tipId)).heldMinor, NET);
  assert.equal((await refundRow(tip.tipId)).id, second.id);
  assert.equal(
    (
      await q(
        `SELECT held_minor::text AS held FROM tip_refunds WHERE id = $1`,
        [first.id],
      )
    )[0].held,
    '0',
  );
  assert.deepEqual(await backsOf(second.id), []);
  assert.equal(await available(TOBI), NET);
  state.refuse = null;
  await send(provider);
  await run(transfers, new Date());
  await send(provider);
  assert.equal(await paid(second.id), 'refunded');
  assert.deepEqual(await linesOf(refundKey(second.id)), [
    line('held_for_recipients', 'person', 'credit', NET),
    line('recipient_payable', 'person', 'debit', NET),
  ]);
  // ₦9,500 moved once: one transfer back, two refund calls (one refused), one booking.
  assert.deepEqual(await allBacks(tip.tipId), [
    { amount: String(NET), status: 'paid' },
  ]);
  assert.equal(moves.backs.length, 1);
  assert.equal((await reversalsOf(tip.tipId)).length, 1);
  // Whole again: only the refunded tip is gone from their balance.
  assert.equal(await available(TOBI), NET);
});

test('the partner’s refund.failed after the part came back keeps it for the next ask', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  const first = await refundAsked(tip.tipId);
  const { provider } = refunder();
  await send(provider);
  await run(transfers, new Date());
  await send(provider);
  assert.equal(
    await ops.applyTipRefundEvent(database.db, {
      tipRefundId: first.id,
      refundState: 'failed',
      partnerReversalId: 'refund.rf_1',
      refundedMinor: null,
      refundFeeMinor: null,
      now: new Date(),
    }),
    'failed',
  );
  const second = await refundAsked(tip.tipId);
  assert.deepEqual(await backsOf(second.id), []);
  await send(provider);
  assert.equal(
    await paid(second.id, { partnerReversalId: 'refund.rf_2' }),
    'refunded',
  );
  assert.equal(moves.backs.length, 1);
  assert.equal(await available(TOBI), 0n);
});

test('a refund not sent after its part was taken back is tried again, never failed', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  state.notSent = true;
  await send(provider);
  assert.equal((await refundRow(tip.tipId)).status, 'REQUESTED');
  state.notSent = false;
  await send(provider, new Date(Date.now() + 5 * MIN));
  assert.equal((await refundRow(tip.tipId)).status, 'PROCESSING');
  assert.equal(state.refunds.length, 2);
  assert.equal(
    state.refunds[1].idempotencyKey,
    `tipme-tip-refund-${refund.id}`,
  );
});

test('a refund refused for another reason than balance says the partner refused it', async () => {
  const tip = await paidTip(TOBI);
  await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  state.refuse = 'CHARGE_ALREADY_REFUNDED';
  await send(provider);
  assert.equal((await refundRow(tip.tipId)).failure, 'refused');
});

const disputeOpens = (tip) =>
  ops.applyDisputeEvent(database.db, {
    event: {
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
      occurredAt: new Date(),
    },
    provider: 'bachs',
    now: new Date(),
  });

test('a dispute opened after the ask stops the refund before it is sent', async () => {
  // Nothing taken back yet: the refund fails, and the share stays held, now for the dispute.
  const tip = await paidTip(TOBI);
  await refundAsked(tip.tipId);
  await disputeOpens(tip);
  const { provider, state } = refunder();
  await send(provider);
  assert.deepEqual(state.refunds, []);
  const failed = await refundRow(tip.tipId);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.failure, 'disputed');
  assert.equal(failed.held, '0');
  const share = await shareOf(tip.rowId);
  assert.equal(share.status, 'review');
  assert.equal(share.review_reason, 'dispute');

  // Already taken back: stopped for good (RC1), never sent by the worker; the part stays held.
  await verified(ADA);
  const { provider: transfers } = partner();
  const moved = await movedTip(ADA, transfers);
  await refundAsked(moved.tipId);
  await send(provider);
  await run(transfers, new Date());
  await disputeOpens(moved);
  await send(provider);
  assert.deepEqual(state.refunds, []);
  const stopped = await refundRow(moved.tipId);
  assert.equal(stopped.status, 'FAILED');
  assert.equal(stopped.failure, 'disputed');
  assert.equal(stopped.held, '0');
  assert.equal((await facts(moved.tipId)).heldMinor, NET);
});

test('a refund whose recovery took over a day is still sent again after a lost answer', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  const later = new Date(Date.now() + 25 * HOUR);
  await run(transfers, later);
  state.lost = true;
  await send(provider, later);
  assert.equal((await refundRow(tip.tipId)).status, 'UNKNOWN');
  state.lost = false;
  // Inside the key's window counted from its first send, the same key again.
  await send(provider, new Date(later.getTime() + 5 * MIN));
  assert.equal(state.refunds.length, 2);
  assert.equal(
    state.refunds[1].idempotencyKey,
    `tipme-tip-refund-${refund.id}`,
  );
  assert.equal((await refundRow(tip.tipId)).status, 'PROCESSING');

  // Past it: never resent blindly; staff are told.
  const other = await paidTip(TOBI);
  const stuck = await refundAsked(other.tipId);
  state.lost = true;
  await send(provider);
  state.lost = false;
  await send(provider, new Date(Date.now() + 24 * HOUR));
  assert.equal(
    state.refunds.filter((r) => r.reference === `tipme-tip-refund-${stuck.id}`)
      .length,
    1,
  );
  assert.equal(
    (
      await q(`SELECT 1 FROM issues WHERE dedupe_key = $1`, [
        `tip_refund_unknown.${stuck.id}`,
      ])
    ).length,
    1,
  );
});

/* Fix round 2 (re-review RC1, RI1, RM1). */

const disputeSays = (tip, status, hoursLater = 0) =>
  ops.applyDisputeEvent(database.db, {
    event: {
      kind: 'dispute',
      eventId: `evt_${randomUUID()}`,
      eventType: status === 'open' ? 'dispute.created' : 'dispute.updated',
      scope: 'platform',
      partnerDisputeId: tip.disputeRef,
      chargeReference: tip.chargeReference,
      providerReference: null,
      operationReference: null,
      status,
      amountMinor: NET,
      currency: 'NGN',
      reason: 'fraudulent',
      respondBy: at(7 * DAY),
      feeMinor: null,
      feeCurrency: null,
      occurredAt: new Date(Date.now() + hoursLater * HOUR),
    },
    provider: 'bachs',
    now: new Date(Date.now() + hoursLater * HOUR),
  });
const lossBalanced = async (tipId) =>
  (
    await q(
      `SELECT COALESCE(SUM(CASE e.side WHEN 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0)::text AS net
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
        WHERE t.tip_id = $1`,
      [tipId],
    )
  )[0].net;

test('a dispute lost after the take-back takes the recipient’s part once, and the refund is never sent', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  assert.equal(moves.backs.length, 1);
  await disputeSays(tip, 'open');
  await send(provider);
  // Stopped for good: never sent by the worker again, the part still held for the tip.
  const stopped = await refundRow(tip.tipId);
  assert.equal(stopped.status, 'FAILED');
  assert.equal(stopped.failure, 'disputed');
  assert.equal(stopped.held, '0');
  assert.equal((await facts(tip.tipId)).heldMinor, NET);
  await disputeSays(tip, 'lost', 1);
  await ops.runDisputeSteps(database.db, {
    now: new Date(Date.now() + 2 * HOUR),
  });
  await run(transfers, new Date(Date.now() + 3 * HOUR));
  await send(provider, new Date(Date.now() + 4 * HOUR));
  // One transfer back in all: the dispute used what the refund already took back.
  assert.equal(moves.backs.length, 1);
  assert.deepEqual(await allBacks(tip.tipId), [
    { amount: String(NET), status: 'paid' },
  ]);
  assert.deepEqual(state.refunds, []);
  const [dispute] = await q(
    `SELECT id, settled_at, held_minor::text AS held FROM disputes WHERE partner_dispute_id = $1`,
    [tip.disputeRef],
  );
  assert.ok(dispute.settled_at);
  assert.deepEqual(
    (await reversalsOf(tip.tipId)).map((r) => r.operation_key),
    [`dispute_loss.${dispute.id}`],
  );
  // The recipient gives back their part once; the hold is consumed with it.
  assert.equal(
    (
      await q(
        `SELECT held_minor::text AS held FROM tip_refunds WHERE id = $1`,
        [refund.id],
      )
    )[0].held,
    '0',
  );
  assert.equal(await available(TOBI), NET);
  assert.equal(await lossBalanced(tip.tipId), '0');
});

test('a dispute lost after a partial take-back: the notice says exactly what the balance holds for it (Task 14 R5-I1)', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  // ₦6,500 of the tip is on its way to their bank, so only ₦3,000 is taken back for the refund.
  const payout = randomUUID();
  await q(
    `INSERT INTO payouts (id, profile_id, currency, amount_minor, status, idempotency_key, request_fingerprint)
     VALUES ($1, $2, 'NGN', 650000, 'REQUESTED', $3, 'test')`,
    [payout, TOBI.id, randomUUID()],
  );
  const requester = await person();
  const approver = await person();
  const absorb = await ask(requester, tip.tipId, 'tip_refund.absorb_gap');
  assert.equal((await approve(absorb.requestId, approver)).status, 'approved');
  const { provider } = refunder();
  await send(provider);
  await run(transfers, new Date());
  // The withdrawal failed: the rest of the tip is back in their balance.
  await q(`UPDATE payouts SET status = 'FAILED' WHERE id = $1`, [payout]);
  await disputeSays(tip, 'open');
  await send(provider);
  const notice = async () => ops.collectDisputeHeldMinor(database.db, TOBI.id);
  const before = { notice: await notice(), available: await available(TOBI) };
  await disputeSays(tip, 'lost', 1);
  await ops.runDisputeSteps(database.db, {
    now: new Date(Date.now() + 2 * HOUR),
  });
  const [dispute] = await q(
    `SELECT d.held_minor::text AS held, d.settled_at,
            (SELECT status FROM collect_transfers b WHERE b.dispute_id = d.id AND b.kind = 'back') AS back
       FROM disputes d WHERE d.partner_dispute_id = $1`,
    [tip.disputeRef],
  );
  // Lost, its own transfer back still to be paid, and its hold already net of the take-back.
  assert.equal(dispute.settled_at, null);
  assert.equal(dispute.back, 'ready');
  assert.ok(BigInt(dispute.held) > 0n, dispute.held);
  const after = { notice: await notice(), available: await available(TOBI) };
  // The notice is the hold, and moves exactly as the balance does.
  assert.equal(after.notice, BigInt(dispute.held));
  assert.equal(
    after.notice - before.notice,
    BigInt(before.available) - BigInt(after.available),
  );
});

test('a dispute won after the take-back keeps the part held and sends nothing; a new ask reuses it', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  await movedTip(TOBI, transfers);
  await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  await disputeSays(tip, 'open');
  await send(provider);
  await disputeSays(tip, 'won', 1);
  await send(provider, new Date(Date.now() + 2 * HOUR));
  assert.deepEqual(state.refunds, []);
  const stopped = await refundRow(tip.tipId);
  assert.equal(stopped.status, 'FAILED');
  assert.equal(stopped.held, '0');
  assert.equal((await facts(tip.tipId)).heldMinor, NET);
  assert.equal(await available(TOBI), NET);
  // Only a new staff ask restarts it, using what is held.
  const again = await refundAsked(tip.tipId);
  assert.deepEqual(await backsOf(again.id), []);
  await send(provider, new Date(Date.now() + 3 * HOUR));
  assert.equal(state.refunds.length, 1);
  assert.equal(moves.backs.length, 1);
});

test('a refund.paid nobody expected opens a money issue and books nothing twice', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  const { provider } = refunder();
  await send(provider);
  await run(transfers, new Date());
  await disputeSays(tip, 'open');
  await send(provider);
  await disputeSays(tip, 'lost', 1);
  await ops.runDisputeSteps(database.db, {
    now: new Date(Date.now() + 2 * HOUR),
  });
  assert.equal(await paid(refund.id), 'noted');
  const [issue] = await q(
    `SELECT severity, summary FROM issues WHERE dedupe_key = $1`,
    [`tip_refund_unexpected.${refund.id}`],
  );
  assert.equal(issue.severity, 'money');
  assert.match(issue.summary, new RegExp(`tipme-tip-refund-${refund.id}`));
  assert.match(issue.summary, /₦9,500/);
  assert.equal((await reversalsOf(tip.tipId)).length, 1);
});

test('staff return money a failed refund took back to the recipient, once', async () => {
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  state.refuse = 'CHARGE_ALREADY_REFUNDED';
  await send(provider);
  assert.equal((await refundRow(tip.tipId)).status, 'FAILED');
  // Staff see what is held for the tip.
  assert.equal((await facts(tip.tipId)).heldMinor, NET);
  assert.equal(await available(TOBI), 0n);
  const requester = await person();
  const approver = await person();
  const asked = await ask(requester, tip.tipId, 'tip_refund.return');
  assert.equal(asked.state, 'pending');
  assert.equal((await approve(asked.requestId, approver)).status, 'approved');
  const [ret] = await q(
    `SELECT id, status, amount_minor::text AS amount, idempotency_key FROM collect_transfers
      WHERE tip_id = $1 AND kind = 'return'`,
    [tip.tipId],
  );
  assert.equal(ret.amount, String(NET));
  assert.equal(ret.idempotency_key, `tipme-collect-return-${refund.id}`);
  // Held until it is paid back to their account.
  assert.equal(await available(TOBI), 0n);
  await run(transfers, new Date());
  const returned = moves.sends.filter(
    (s) => s.idempotencyKey === `tipme-collect-return-${refund.id}`,
  );
  assert.equal(returned.length, 1);
  assert.deepEqual(
    (await linesOf(`collect_transfer.${ret.id}`)).map((l) => [
      l.code,
      l.side,
      l.amount,
    ]),
    [
      ['held_for_recipients', 'credit', String(NET)],
      ['provider_clearing', 'debit', String(NET)],
    ],
  );
  assert.equal(await available(TOBI), NET);
  assert.equal((await facts(tip.tipId)).heldMinor, 0n);
  // Nothing left to return: a second return is refused.
  await assert.rejects(ask(requester, tip.tipId, 'tip_refund.return'), {
    code: 'TIP_REFUND_REFUSED',
  });
  await run(transfers, new Date());
  assert.equal(
    moves.sends.filter(
      (s) => s.idempotencyKey === `tipme-collect-return-${refund.id}`,
    ).length,
    1,
  );
});

test('a return is refused while a refund is open or a dispute is unsettled', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  await refundAsked(tip.tipId);
  const { provider } = refunder();
  await send(provider);
  await run(transfers, new Date());
  const requester = await person();
  await person();
  await assert.rejects(ask(requester, tip.tipId, 'tip_refund.return'), {
    code: 'TIP_REFUND_REFUSED',
  });
  await disputeSays(tip, 'open');
  await send(provider);
  assert.equal((await refundRow(tip.tipId)).status, 'FAILED');
  await assert.rejects(ask(requester, tip.tipId, 'tip_refund.return'), {
    code: 'TIP_REFUND_REFUSED',
  });
});

test('a refund that keeps failing to leave backs off, then tells staff', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  state.notSent = true;
  const t0 = Date.now();
  await send(provider, new Date(t0));
  assert.equal(state.refunds.length, 1);
  // Not again at once: it waits.
  await send(provider, new Date(t0 + MIN));
  assert.equal(state.refunds.length, 1);
  // One try that never left is no news for staff yet (RM4).
  assert.deepEqual(
    await q(`SELECT 1 FROM issues WHERE dedupe_key = $1`, [
      `tip_refund_not_sent.${refund.id}`,
    ]),
    [],
  );
  for (let n = 1; n <= 6; n += 1)
    await send(provider, new Date(t0 + n * 7 * HOUR));
  assert.equal((await refundRow(tip.tipId)).status, 'REQUESTED');
  assert.equal(
    (
      await q(`SELECT 1 FROM issues WHERE dedupe_key = $1`, [
        `tip_refund_not_sent.${refund.id}`,
      ])
    ).length,
    1,
  );
});

/* Fix round 3 (re-review RC2, RI3, RM3, RM4). */

/** A held share whose refund was sent but the partner's answer was lost: UNKNOWN. */
async function unknownRefund() {
  const tip = await paidTip(TOBI);
  const refund = await refundAsked(tip.tipId);
  const partnerSide = refunder();
  partnerSide.state.lost = true;
  await send(partnerSide.provider);
  partnerSide.state.lost = false;
  assert.equal((await refundRow(tip.tipId)).status, 'UNKNOWN');
  return { tip, refund, ...partnerSide };
}

test('a dispute on a refund whose answer was lost leaves it unknown: a win releases nothing and a re-ask is refused', async () => {
  const { tip, refund, provider, state } = await unknownRefund();
  await disputeSays(tip, 'open');
  // Never failed, never resent while a dispute is open: it may already be made.
  await send(provider, new Date(Date.now() + 5 * MIN));
  assert.equal(state.refunds.length, 1);
  assert.equal((await refundRow(tip.tipId)).status, 'UNKNOWN');
  assert.equal(
    (
      await q(`SELECT 1 FROM issues WHERE dedupe_key = $1`, [
        `tip_refund_disputed_unknown.${refund.id}`,
      ])
    ).length,
    1,
  );
  await disputeSays(tip, 'won', 1);
  await ops.runDisputeSteps(database.db, {
    now: new Date(Date.now() + 2 * HOUR),
  });
  // Still held for the refund that may be made: nothing goes back to the recipient.
  const share = await shareOf(tip.rowId);
  assert.equal(share.status, 'review');
  assert.equal(share.review_reason, 'refund');
  assert.equal(await available(TOBI), 0n);
  assert.equal((await facts(tip.tipId)).refusal, 'already');
  const requester = await person();
  await person();
  await assert.rejects(ask(requester, tip.tipId), {
    code: 'TIP_REFUND_REFUSED',
  });
  await assert.rejects(ask(requester, tip.tipId, 'tip_refund.return'), {
    code: 'TIP_REFUND_REFUSED',
  });
});

test('a dispute on a refund whose answer was lost, then the partner says paid: booked once', async () => {
  const { tip, refund } = await unknownRefund();
  await disputeSays(tip, 'open');
  assert.equal(await paid(refund.id), 'refunded');
  assert.equal(await paid(refund.id), 'already');
  assert.deepEqual(await reversalsOf(tip.tipId), [
    { operation_key: refundKey(refund.id) },
  ]);
  assert.equal((await shareOf(tip.rowId)).status, 'cancelled');
});

test('a dispute lost while a refund was unknown, then the partner says paid: staff told both went out, books balanced', async () => {
  const { tip, refund } = await unknownRefund();
  await disputeSays(tip, 'open');
  await disputeSays(tip, 'lost', 1);
  await ops.runDisputeSteps(database.db, {
    now: new Date(Date.now() + 2 * HOUR),
  });
  // The loss waits for the refund that may be made.
  const [waiting] = await q(
    `SELECT id, settled_at FROM disputes WHERE partner_dispute_id = $1`,
    [tip.disputeRef],
  );
  assert.equal(waiting.settled_at, null);
  assert.equal(await paid(refund.id), 'refunded');
  await ops.runDisputeSteps(database.db, {
    now: new Date(Date.now() + 3 * HOUR),
  });
  const [issue] = await q(
    `SELECT severity, summary FROM issues WHERE dedupe_key = $1`,
    [`tip_refund_and_dispute.${tip.tipId}`],
  );
  assert.equal(issue.severity, 'money');
  assert.match(issue.summary, /refund of ₦9,500/);
  assert.match(issue.summary, /dispute of ₦9,500/);
  assert.equal((await reversalsOf(tip.tipId)).length, 2);
  assert.equal(await lossBalanced(tip.tipId), '0');
});

test('an unexpected refund.paid leaves the tip unrefundable and shows what was not booked', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  await disputeSays(tip, 'open');
  await send(provider);
  await disputeSays(tip, 'won', 1);
  assert.equal(await paid(refund.id), 'noted');
  const seen = await facts(tip.tipId);
  assert.equal(seen.refusal, 'paid_unbooked');
  assert.equal(seen.unbookedMinor, NET);
  // Held money stays reported for what it is; the unbooked refund is shown beside it.
  const requester = await person();
  await person();
  await assert.rejects(ask(requester, tip.tipId), {
    code: 'TIP_REFUND_REFUSED',
  });
  await assert.rejects(ask(requester, tip.tipId, 'tip_refund.return'), {
    code: 'TIP_REFUND_REFUSED',
  });
  await send(provider, new Date(Date.now() + HOUR));
  assert.deepEqual(state.refunds, []);
});

test('after a lost dispute used what a refund took back, nothing is reported held', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  await refundAsked(tip.tipId);
  const { provider } = refunder();
  await send(provider);
  await run(transfers, new Date());
  await disputeSays(tip, 'open');
  await send(provider);
  await disputeSays(tip, 'lost', 1);
  await ops.runDisputeSteps(database.db, {
    now: new Date(Date.now() + 2 * HOUR),
  });
  assert.equal((await facts(tip.tipId)).heldMinor, 0n);
});

test('the send claim refuses a tip with a lost dispute, and a tip whose money already went back (RM4)', async () => {
  // A lost dispute on record, nothing booked yet: the claim alone refuses.
  const lostTip = await paidTip(TOBI);
  const lostRefund = await refundAsked(lostTip.tipId);
  await q(`UPDATE tip_refunds SET recovered_at = now() WHERE id = $1`, [
    lostRefund.id,
  ]);
  await q(
    `INSERT INTO disputes (id, provider, partner_dispute_id, tip_id, amount_minor, currency, status, last_event_at, decided_at)
     VALUES (gen_random_uuid(), 'bachs', $1, $2, 950000, 'NGN', 'lost', now(), now())`,
    [`dp_${randomUUID().slice(0, 8)}`, lostTip.tipId],
  );
  assert.equal(
    await ops.claimCollectRefund(database.db, {
      refundId: lostRefund.id,
      now: new Date(),
    }),
    false,
  );
  // A tip whose refund was already booked, with a stray unsent refund row: refused.
  const doneTip = await paidTip(ADA);
  const done = await refundAsked(doneTip.tipId);
  const { provider } = refunder();
  await send(provider);
  await paid(done.id);
  await q(
    `UPDATE tip_refunds SET status = 'FAILED', failure = 'refused' WHERE id = $1`,
    [done.id],
  );
  const [{ id: stray }] = await q(
    `INSERT INTO tip_refunds (id, tip_id, status, amount_minor, currency, provider, provider_reference,
            requested_by, reason, collect_plan, recovered_at)
     SELECT gen_random_uuid(), tip_id, 'REQUESTED', amount_minor, currency, provider, provider_reference,
            requested_by, reason, 'cancel_held', now() FROM tip_refunds WHERE id = $1 RETURNING id`,
    [done.id],
  );
  assert.equal(
    await ops.claimCollectRefund(database.db, {
      refundId: stray,
      now: new Date(),
    }),
    false,
  );
});

/*
 * RI4 (fix round 4): every unit of a recipient's money is counted once. A dispute's hold on a tip
 * and that tip's refund take-back can name the same money: the dispute's hold counts only what the
 * tip's refunds don't already hold (their reservation, or the money their transfers back brought in,
 * net of returns). Two moved tips of NET each: the disputed or refunded one, and the other's money.
 */

/** Payable less reserved less held, and the two parts, as `balanceQuery` reads them. */
async function moneyOf(profile) {
  const {
    rows: [row],
  } = await database.db.execute(ops.balanceQuery(profile.id));
  const balance = await ops.balanceOf(database.db, profile.id);
  return {
    available: balance.availableMinor,
    reserved: BigInt(row.reserved),
    held: BigInt(row.held),
  };
}
/** Every posting balances: debits equal credits, per currency. */
const ledgerBalanced = async () =>
  (
    await q(
      `SELECT t.currency, SUM(CASE e.side WHEN 'debit' THEN e.amount_minor ELSE -e.amount_minor END)::text AS net
         FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
        GROUP BY t.currency HAVING SUM(CASE e.side WHEN 'debit' THEN e.amount_minor ELSE -e.amount_minor END) <> 0`,
    )
  ).length === 0;

async function moneyCase(profile) {
  await verified(profile);
  const { provider: transfers } = partner();
  const tip = await movedTip(profile, transfers);
  await movedTip(profile, transfers);
  const refunds = refunder();
  const later = (hours) => new Date(Date.now() + hours * HOUR);
  const ctx = { tip, refund: null };
  const steps = {
    closed: () => disputeSays(tip, 'closed'),
    open: () => disputeSays(tip, 'open'),
    won: () => disputeSays(tip, 'won', 1),
    lost: async () => {
      await disputeSays(tip, 'lost', 1);
      await ops.runDisputeSteps(database.db, { now: later(2) });
      await run(transfers, later(3));
      await ops.runDisputeSteps(database.db, { now: later(4) });
    },
    ask: async () => {
      ctx.refund = await refundAsked(tip.tipId);
    },
    // The worker releases the transfer back, and the transfer machine pays it.
    back: async () => {
      await send(refunds.provider);
      await run(transfers, new Date());
    },
    send: () => send(refunds.provider),
    refundPaid: () => paid(ctx.refund.id),
    refundFails: async () => {
      refunds.state.refuse = 'CHARGE_ALREADY_REFUNDED';
      await send(refunds.provider);
      refunds.state.refuse = null;
      assert.equal((await refundRow(tip.tipId)).status, 'FAILED');
    },
    return: async () => {
      const requester = await person();
      const approver = await person();
      const asked = await ask(requester, tip.tipId, 'tip_refund.return');
      assert.equal(asked.state, 'pending', JSON.stringify(asked));
      assert.equal(
        (await approve(asked.requestId, approver)).status,
        'approved',
      );
      await run(transfers, new Date());
    },
    release: () => ops.runDisputeSteps(database.db, { now: later(15 * 24) }),
  };
  return { ctx, steps };
}

const N = NET;
/** [step, available, reserved, held] after each step; the other tip's NET is always theirs. */
const MONEY_CASES = [
  {
    name: 'no dispute: asked, taken back, sent, paid',
    steps: [
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['send', N, 0n, N],
      ['refundPaid', N, 0n, 0n],
    ],
  },
  {
    name: 'no dispute: taken back, the refund fails, returned',
    steps: [
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['refundFails', N, 0n, N],
      ['return', 2n * N, 0n, 0n],
    ],
  },
  {
    name: 'closed dispute kept (P28), then the refund takes it back and is paid',
    steps: [
      ['closed', N, N, 0n],
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['send', N, 0n, N],
      ['refundPaid', N, 0n, 0n],
    ],
  },
  {
    name: 'closed dispute kept, taken back, the refund fails, returned, then the dispute’s release',
    steps: [
      ['closed', N, N, 0n],
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['refundFails', N, 0n, N],
      // Back in their account, and still kept for a refund until the dispute's own release.
      ['return', N, N, 0n],
      ['release', 2n * N, 0n, 0n],
    ],
  },
  {
    name: 'closed dispute kept, taken back, the refund fails, the dispute released, then returned',
    steps: [
      ['closed', N, N, 0n],
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['refundFails', N, 0n, N],
      ['release', N, 0n, N],
      ['return', 2n * N, 0n, 0n],
    ],
  },
  {
    name: 'asked, then a dispute opens before anything is taken back, and is won',
    steps: [
      ['ask', N, N, 0n],
      ['open', N, N, 0n],
      ['send', N, N, 0n],
      ['won', 2n * N, 0n, 0n],
    ],
  },
  {
    name: 'taken back, then a dispute opens and is won, then returned',
    steps: [
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['open', N, 0n, N],
      ['send', N, 0n, N],
      ['won', N, 0n, N],
      ['return', 2n * N, 0n, 0n],
    ],
  },
  {
    name: 'taken back, then a dispute opens and closes (kept), returned, then released',
    steps: [
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['open', N, 0n, N],
      ['send', N, 0n, N],
      ['closed', N, 0n, N],
      ['return', N, N, 0n],
      ['release', 2n * N, 0n, 0n],
    ],
  },
  {
    name: 'taken back, then a dispute opens and is lost: the refund’s money pays it',
    steps: [
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['open', N, 0n, N],
      ['send', N, 0n, N],
      ['lost', N, 0n, 0n],
    ],
  },
  {
    name: 'taken back, the refund fails, then a dispute opens and is won, then returned',
    steps: [
      ['ask', N, N, 0n],
      ['back', N, 0n, N],
      ['refundFails', N, 0n, N],
      ['open', N, 0n, N],
      ['won', N, 0n, N],
      ['return', 2n * N, 0n, 0n],
    ],
  },
];

for (const scenario of MONEY_CASES)
  test(`RI4 money counted once: ${scenario.name}`, async () => {
    const { steps } = await moneyCase(TOBI);
    assert.deepEqual(await moneyOf(TOBI), {
      available: 2n * N,
      reserved: 0n,
      held: 0n,
    });
    for (const [step, available, reserved, held] of scenario.steps) {
      await steps[step]();
      assert.deepEqual(
        await moneyOf(TOBI),
        { available, reserved, held },
        `after ${step}`,
      );
      assert.ok(await ledgerBalanced(), `ledger balanced after ${step}`);
    }
  });

test('RI4: a closed dispute’s kept hold and the refund’s paid take-back never count the same money twice', async () => {
  // The reviewer's probe 8b: one moved tip, the dispute closed, the refund's transfer back paid.
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  await disputeSays(tip, 'closed');
  assert.equal(await available(TOBI), 0n);
  const refund = await refundAsked(tip.tipId);
  assert.equal(refund.held, '0');
  assert.equal(await available(TOBI), 0n);
  const { provider } = refunder();
  await send(provider);
  await run(transfers, new Date());
  assert.deepEqual(await moneyOf(TOBI), {
    available: 0n,
    reserved: 0n,
    held: NET,
  });
  await send(provider);
  assert.equal(await paid(refund.id), 'refunded');
  assert.deepEqual(await moneyOf(TOBI), {
    available: 0n,
    reserved: 0n,
    held: 0n,
  });
  assert.ok(await ledgerBalanced());
});

test('RM6: the refund’s reservation ends when its transfer back is paid, with other money present', async () => {
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  await movedTip(TOBI, transfers);
  const refund = await refundAsked(tip.tipId);
  assert.equal(refund.held, String(NET));
  const before = await available(TOBI);
  assert.equal(before, NET);
  const { provider } = refunder();
  await send(provider);
  await run(transfers, new Date());
  assert.equal((await backsOf(refund.id))[0].status, 'paid');
  assert.equal((await refundRow(tip.tipId)).held, '0');
  assert.equal(await available(TOBI), before);
});

test('RM7: money held for a refund shows as held for a refund, never “On its way to you”', async () => {
  // Verified: a moved tip's money taken back for its refund.
  await verified(TOBI);
  const { provider: transfers } = partner();
  const tip = await movedTip(TOBI, transfers);
  await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  const now = new Date();
  const seen = async (profile) => {
    const balance = await ops.balanceOf(database.db, profile.id);
    const dashboard = await ops.dashboardSummary(database.db, profile.id, now);
    const status = await ops.collectStatus(database.db, profile.id, now);
    return {
      balance: [
        balance.keptMinor,
        balance.onItsWayMinor,
        balance.refundHeldMinor,
      ],
      dashboard: [
        dashboard.keptMinor,
        dashboard.onItsWayMinor,
        dashboard.refundHeldMinor,
      ],
      status: [status.keptMinor, status.onItsWayMinor, status.refundHeldMinor],
    };
  };
  assert.deepEqual(await seen(TOBI), {
    balance: [0n, 0n, NET],
    dashboard: ['0', '0', String(NET)],
    status: [0n, 0n, NET],
  });
  // The refund fails: still held for it, not on its way.
  state.refuse = 'CHARGE_ALREADY_REFUNDED';
  await send(provider);
  assert.deepEqual((await seen(TOBI)).balance, [0n, 0n, NET]);
  // Returned: theirs again, in their account.
  const requester = await person();
  const approver = await person();
  const asked = await ask(requester, tip.tipId, 'tip_refund.return');
  await approve(asked.requestId, approver);
  await run(transfers, new Date());
  assert.deepEqual(await seen(TOBI), {
    balance: [0n, 0n, 0n],
    dashboard: ['0', '0', '0'],
    status: [0n, 0n, 0n],
  });

  // Not verified: a share still held, held for its refund, is not "Kept for you" either.
  const held = await paidTip(ADA);
  const another = await paidTip(ADA);
  void another;
  await refundAsked(held.tipId);
  const ada = await ops.balanceOf(database.db, ADA.id);
  assert.deepEqual(
    [ada.keptMinor, ada.onItsWayMinor, ada.refundHeldMinor],
    [NET, 0n, NET],
  );
  // The recipient's words for each part; none names the payment partner.
  assert.deepEqual(contracts.COLLECT_HELD_WORDS, {
    kept: 'Kept for you until you add your bank details',
    onItsWay: 'On its way to you',
    refundHeld: 'Held while a refund is settled',
  });
});

/* RM8 (fix round 5): each of these fails when its own check is removed. */

/** One moved tip whose money a failed refund took back: all they have is held for the refund. */
async function onlyRefundHeld(profile) {
  await verified(profile);
  const { provider: transfers } = partner();
  const tip = await movedTip(profile, transfers);
  await refundAsked(tip.tipId);
  const { provider, state } = refunder();
  await send(provider);
  await run(transfers, new Date());
  state.refuse = 'CHARGE_ALREADY_REFUNDED';
  await send(provider);
  assert.equal((await refundRow(tip.tipId)).status, 'FAILED');
  const balance = await ops.balanceOf(database.db, profile.id);
  assert.deepEqual(balance, {
    availableMinor: 0n,
    confirmingMinor: 0n,
    keptMinor: 0n,
    onItsWayMinor: 0n,
    refundHeldMinor: NET,
  });
  return tip;
}

test('RM8: an account whose only money is held for a refund cannot be deleted', async () => {
  await onlyRefundHeld(TOBI);
  let [{ user_id: userId }] = await q(
    `SELECT user_id FROM profiles WHERE id = $1`,
    [TOBI.id],
  );
  if (!userId) {
    [{ id: userId }] = await q(
      `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
      [`collectrefund.owner.${randomUUID().slice(0, 8)}@example.com`],
    );
    await q(`UPDATE profiles SET user_id = $2 WHERE id = $1`, [
      TOBI.id,
      userId,
    ]);
  }
  await assert.rejects(ops.deleteAccount(database.db, { userId, sealing }), {
    code: 'HAS_BALANCE',
  });
});

test('RM8: a page whose only money is held for a refund shows as having a balance to a take-back', async () => {
  await onlyRefundHeld(TOBI);
  const facts = await ops.takeBackFacts(database.db, TOBI.id);
  assert.equal(facts.hasBalance, true);
});

test('RM8: a re-ask after a closed dispute’s hold was taken back reads only what is still in their account', async () => {
  // ₦6,500 is on its way to their bank, so the closed dispute keeps the ₦3,000 left (P28).
  await verified(TOBI);
  const { provider: transfers, state: moves } = partner();
  const tip = await movedTip(TOBI, transfers);
  await withdrawing(TOBI, 650_000n);
  await disputeSays(tip, 'closed');
  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'staff_decides',
    gapMinor: 650_000n,
  });
  await refundAsked(tip.tipId, 'tip_refund.absorb_gap');
  const { provider, state } = refunder();
  state.balance = 100_000_000n;
  await send(provider);
  await run(transfers, new Date());
  assert.deepEqual(
    moves.backs.map((b) => b.amountMinor),
    [300_000n],
  );
  state.refuse = 'CHARGE_ALREADY_REFUNDED';
  await send(provider);
  assert.equal((await refundRow(tip.tipId)).status, 'FAILED');
  // The ₦3,000 the hold kept is now held by TipMe for the tip: nothing of it is in their account,
  // so the rest (₦6,500) is all a gap, never a second transfer back of money that isn't there.
  assert.equal(await available(TOBI), 0n);
  assert.deepEqual((await facts(tip.tipId)).collect, {
    plan: 'staff_decides',
    gapMinor: 650_000n,
  });
});
