import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import {
  CollectTransferRefusedError,
  UncertainProviderOutcomeError,
} from '../../packages/payments/dist/index.js';
import { setSwitch } from './helpers.mjs';

/*
 * You collect (plan Task 8, spec §5, R9–R11, P8, P13, P20): each held share moves from TipMe's own
 * partner balance to the recipient's account exactly once. The claim (`ready → sent`) is committed
 * before the partner is called; every state change is a conditional update; a lost answer is asked
 * again with the same key `tipme-collect-<tipId>` within 24 hours and read back by `transfer_group`
 * after that. `ORGANIZATION_IN_DEBT` freezes every collect transfer behind one issue; staff's pause
 * (`collect_settings.paused`) stops the run. No partner is called: a fake answers instead.
 */

const [ADA, TOBI] = ops.DEMO_PROFILES;
const GROSS = 1_000_000n; // ₦10,000 on Free: TipMe keeps 5%.
const NET = 950_000n;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
// Three days ago, to the minute: the webhook path reads the real clock, and must be after T0.
const T0 = new Date(Math.floor(Date.now() / MIN) * MIN - 3 * DAY);
const at = (ms) => new Date(T0.getTime() + ms);
const ACCOUNTS = {
  [TOBI.id]: 'acct_tobi_person',
  [ADA.id]: 'acct_ada_person',
};
const sealing = ops.mailSealing(Buffer.alloc(32, 9));

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
  // Long-standing recipients: no new-recipient delay (§8), so a share is released at settlement.
  await q(`UPDATE profiles SET created_at = $1`, [at(-30 * DAY)]);
});

/** A recipient who has added bank details and been verified (Task 13's outcome, written here). */
async function verified(profile, { destination = 'usable' } = {}) {
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
     VALUES ($1, $2, 'bachs', $3, '058', 'Pretend Guaranty Bank', '1234', $4)`,
    [randomUUID(), profile.id, `dest_${profile.handle}`, destination],
  );
}

/** A paid collect tip: booked as held money with one waiting share (Task 7), settled at `settledAt`. */
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
  assert.equal(quote.collectionMode, 'collect');
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = `platform:cs_${randomUUID().slice(0, 8)}`;
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: reference,
  });
  // Started just before it settled, on the test's clock.
  await q(`UPDATE payment_attempts SET created_at = $2 WHERE id = $1`, [
    intent.attemptId,
    new Date(settledAt.getTime() - MIN),
  ]);
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
          chargeReference: `ch_${randomUUID().slice(0, 8)}`,
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
    rowId: row.id,
    key: `tipme-collect-${intent.tipId}`,
  };
}

const CODES = {
  insufficient: 'INSUFFICIENT_BALANCE',
  capability: 'FORBIDDEN',
  in_debt: 'ORGANIZATION_IN_DEBT',
  not_found: 'NOT_FOUND',
  other: 'VALIDATION_ERROR',
};

/**
 * A stand-in for the partner. Each send takes the next scripted answer (none: it pays); a transfer
 * that moved is kept under its key, so the same key replays it and the list shows it by group.
 * `lost` moves the money and loses the answer; `lost-unmoved` loses a request that never arrived;
 * `{ refuse }` is a definite refusal; `{ moveMinor }` moves another amount than asked.
 */
function partner() {
  const state = {
    sends: [],
    lists: [],
    capabilityReads: [],
    moved: new Map(),
    answers: [],
    capability: 'active',
    listFails: false,
    delayMs: 0,
  };
  const provider = {
    name: 'bachs-sandbox',
    async sendCollectTransfer(input) {
      state.sends.push({ ...input });
      if (state.delayMs)
        await new Promise((done) => setTimeout(done, state.delayMs));
      const answer = state.answers.shift();
      if (answer?.refuse)
        throw new CollectTransferRefusedError(
          answer.refuse,
          CODES[answer.refuse],
        );
      if (answer === 'lost-unmoved')
        throw new UncertainProviderOutcomeError(
          input.idempotencyKey,
          'no answer',
          {
            cause: 'no_response',
          },
        );
      let transfer = state.moved.get(input.idempotencyKey);
      if (!transfer) {
        transfer = {
          transferRef: `tr_${state.moved.size + 1}`,
          status: 'paid',
          amountMinor: answer?.moveMinor ?? input.amountMinor,
          currency: input.currency,
          group: input.idempotencyKey,
          accountRef: input.accountRef,
        };
        state.moved.set(input.idempotencyKey, transfer);
      }
      if (answer === 'lost' || transfer.amountMinor !== input.amountMinor)
        throw new UncertainProviderOutcomeError(
          input.idempotencyKey,
          'no answer',
          {
            cause: answer === 'lost' ? 'no_response' : 'unexpected_state',
          },
        );
      return { transferRef: transfer.transferRef, status: 'paid' };
    },
    async listAccountTransfers(accountRef) {
      state.lists.push(accountRef);
      if (state.listFails)
        throw new UncertainProviderOutcomeError(
          `transfers.${accountRef}`,
          'unreadable',
          {
            cause: 'http_error',
          },
        );
      return [...state.moved.values()]
        .filter((transfer) => transfer.accountRef === accountRef)
        .map((transfer) => ({
          transferRef: transfer.transferRef,
          status: transfer.status,
          amountMinor: transfer.amountMinor,
          currency: transfer.currency,
          group: transfer.group,
        }));
    },
    async payoutCapability(accountRef) {
      state.capabilityReads.push(accountRef);
      return { status: state.capability, requirementsDue: [] };
    },
  };
  return { provider, state };
}

const run = (provider, now, more = {}) =>
  ops.runCollectTransfers(database.db, { provider, now, ...more });
const release = (now, more = {}) =>
  ops.releaseWaitingTransfers(database.db, { now, ...more });
const rowOf = async (rowId) =>
  (
    await q(
      `SELECT status, review_reason, account_reference, transfer_reference, attempts,
              next_try_at, sent_at, paid_at
         FROM collect_transfers WHERE id = $1`,
      [rowId],
    )
  )[0];
const postingsOf = (tipId) =>
  q(
    `SELECT operation_key AS key FROM ledger_transactions
      WHERE tip_id = $1 AND operation_type = 'collect_transfer'`,
    [tipId],
  );
const linesOf = (rowId) =>
  q(
    `SELECT a.code, CASE WHEN a.profile_id IS NULL THEN 'tipme' ELSE 'person' END AS owner,
            e.side::text AS side, e.amount_minor::text AS amount
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.operation_key = $1 ORDER BY a.code`,
    [`collect_transfer.${rowId}`],
  );
const issuesOf = (kind) =>
  q(
    `SELECT dedupe_key, status, subject FROM issues WHERE kind = $1 ORDER BY opened_at`,
    [kind],
  );
const resolve = (issueId) =>
  database.db.transaction((tx) =>
    ops.markResolved(tx, {
      issueId,
      resolvedBy: 'staff',
      staffUserId: null,
      reason: 'Topped up in a test',
      now: at(3 * HOUR),
    }),
  );

test('a share is released only to a verified account with a usable bank, after its delay, and takes the account read then (P8)', async () => {
  const tip = await paidTip(TOBI);
  // Not verified yet: it waits, with no account on the row.
  assert.equal(await release(T0), 0);
  assert.deepEqual(
    { ...(await rowOf(tip.rowId)), next_try_at: undefined },
    {
      status: 'waiting',
      review_reason: null,
      account_reference: null,
      transfer_reference: null,
      attempts: 0,
      next_try_at: undefined,
      sent_at: null,
      paid_at: null,
    },
  );
  // A bank still in review keeps it waiting (Review Focus 2's first half).
  await verified(TOBI, { destination: 'pending_review' });
  assert.equal(await release(T0), 0);
  await q(
    `UPDATE payout_destinations SET status = 'usable' WHERE profile_id = $1`,
    [TOBI.id],
  );
  // The new-recipient delay: not before release_after.
  await q(`UPDATE collect_transfers SET release_after = $2 WHERE id = $1`, [
    tip.rowId,
    at(HOUR),
  ]);
  assert.equal(await release(T0), 0);
  // An open dispute on the tip keeps it waiting too.
  const disputeId = randomUUID();
  await q(
    `INSERT INTO disputes (id, provider, partner_dispute_id, tip_id, amount_minor, currency, status, last_event_at)
     VALUES ($1, 'bachs', $2, $3, $4, 'NGN', 'open', $5)`,
    [disputeId, `dp_${disputeId.slice(0, 8)}`, tip.tipId, GROSS, T0],
  );
  assert.equal(await release(at(2 * HOUR)), 0);
  await q(`UPDATE disputes SET status = 'won' WHERE id = $1`, [disputeId]);
  // Released: the account is the one verified now, read at this moment.
  assert.equal(await release(at(2 * HOUR)), 1);
  const row = await rowOf(tip.rowId);
  assert.equal(row.status, 'ready');
  assert.equal(row.account_reference, ACCOUNTS[TOBI.id]);
  // Once.
  assert.equal(await release(at(2 * HOUR)), 0);
});

test('exactly one transfer per tip under eight concurrent workers', async () => {
  await verified(TOBI);
  const tip = await paidTip(TOBI);
  assert.equal(await release(T0), 1);
  const { provider, state } = partner();
  state.delayMs = 50;
  // Eight open connections first, so the eight workers really do race for the row.
  await Promise.all(
    Array.from({ length: 8 }, () => q(`SELECT pg_sleep(0.05)`)),
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, () => run(provider, at(MIN))),
  );
  assert.equal(state.sends.length, 1);
  assert.deepEqual(state.sends[0], {
    accountRef: ACCOUNTS[TOBI.id],
    amountMinor: NET,
    currency: 'NGN',
    idempotencyKey: tip.key,
  });
  assert.equal(
    results.reduce((sum, result) => sum + result.paid, 0),
    1,
  );
  assert.deepEqual(await postingsOf(tip.tipId), [
    { key: `collect_transfer.${tip.rowId}` },
  ]);
  // The held money left TipMe's balance for the recipient's account: no payable moved.
  assert.deepEqual(await linesOf(tip.rowId), [
    {
      code: 'held_for_recipients',
      owner: 'person',
      side: 'credit',
      amount: NET.toString(),
    },
    {
      code: 'provider_clearing',
      owner: 'tipme',
      side: 'debit',
      amount: NET.toString(),
    },
  ]);
  const row = await rowOf(tip.rowId);
  assert.equal(row.status, 'paid');
  assert.equal(row.transfer_reference, 'tr_1');
  // Eight more runs later change nothing.
  await Promise.all(Array.from({ length: 8 }, () => run(provider, at(HOUR))));
  assert.equal(state.sends.length, 1);
  assert.equal((await postingsOf(tip.tipId)).length, 1);
});

/** A worker that died after committing its claim: the row is `sent`, and nothing else is known. */
const crashedAfterClaim = (rowId, when) =>
  q(
    `UPDATE collect_transfers SET status = 'sent', sent_at = $2, updated_at = $2, attempts = 1
      WHERE id = $1 AND status = 'ready'`,
    [rowId, when],
  );

test('a crash after the claim is read back by transfer group: found means paid, not found means sent again with the same key', async () => {
  await verified(TOBI);
  const moved = await paidTip(TOBI);
  const lost = await paidTip(TOBI);
  assert.equal(await release(T0), 2);
  const { provider, state } = partner();
  // The first one reached the partner before the worker died; the second never left.
  state.moved.set(moved.key, {
    transferRef: 'tr_before_crash',
    status: 'paid',
    amountMinor: NET,
    currency: 'NGN',
    group: moved.key,
    accountRef: ACCOUNTS[TOBI.id],
  });
  await crashedAfterClaim(moved.rowId, T0);
  await crashedAfterClaim(lost.rowId, T0);
  // Within READ_BACK_AFTER_MS of the claim, a claimed row is left alone (its worker may be sending).
  await run(provider, at(MIN));
  assert.equal(state.lists.length, 0);
  assert.equal(state.sends.length, 0);
  // Later: read back by group.
  const result = await run(provider, at(3 * MIN));
  assert.ok(state.lists.length >= 1);
  assert.equal((await rowOf(moved.rowId)).status, 'paid');
  assert.equal(
    (await rowOf(moved.rowId)).transfer_reference,
    'tr_before_crash',
  );
  assert.equal((await postingsOf(moved.tipId)).length, 1);
  // Not found: sent again, with the same key and never a new one.
  assert.deepEqual(
    state.sends.map((send) => send.idempotencyKey),
    [lost.key],
  );
  assert.equal((await rowOf(lost.rowId)).status, 'paid');
  assert.equal((await postingsOf(lost.tipId)).length, 1);
  assert.equal(result.paid, 2);
});

test('eight workers reading back one crashed claim send it again once, and book it once', async () => {
  await verified(TOBI);
  const tip = await paidTip(TOBI);
  assert.equal(await release(T0), 1);
  await crashedAfterClaim(tip.rowId, T0);
  const { provider, state } = partner();
  state.delayMs = 50;
  await Promise.all(
    Array.from({ length: 8 }, () => q(`SELECT pg_sleep(0.05)`)),
  );
  await Promise.all(
    Array.from({ length: 8 }, () => run(provider, at(5 * MIN))),
  );
  assert.deepEqual(
    state.sends.map((send) => send.idempotencyKey),
    [tip.key],
  );
  assert.equal((await rowOf(tip.rowId)).status, 'paid');
  assert.equal((await postingsOf(tip.tipId)).length, 1);
});

test('a lost answer is retried with the same key inside 24 hours, and never after', async () => {
  await verified(TOBI);
  const tip = await paidTip(TOBI);
  const unmoved = await paidTip(TOBI);
  assert.equal(await release(T0), 2);
  const { provider, state } = partner();
  // Both answers are lost: the first moved, the second never arrived.
  state.answers.push('lost', 'lost-unmoved');
  const first = await run(provider, T0);
  assert.equal(first.retried, 2);
  assert.equal((await rowOf(tip.rowId)).status, 'unknown');
  assert.equal((await rowOf(unmoved.rowId)).status, 'unknown');
  // Inside 24 hours: the same key again, even while the list can't be read.
  state.listFails = true;
  state.answers.push('lost', 'lost-unmoved');
  await run(provider, at(10 * MIN));
  assert.deepEqual(
    state.sends.map((send) => send.idempotencyKey),
    [tip.key, unmoved.key, tip.key, unmoved.key],
  );
  assert.equal(state.lists.length, 0);
  assert.equal((await rowOf(tip.rowId)).status, 'unknown');
  // After 24 hours: never sent blindly. While the list can't be read, nothing moves.
  await run(provider, at(25 * HOUR));
  assert.equal(state.sends.length, 4);
  assert.ok(state.lists.length >= 1);
  assert.equal((await rowOf(tip.rowId)).status, 'unknown');
  // Read back: the one that moved is paid without another send; the other is not there, so it is
  // sent once more with the same key (the partner's 24 hours on that key are over).
  state.listFails = false;
  await run(provider, at(26 * HOUR));
  assert.equal((await rowOf(tip.rowId)).status, 'paid');
  assert.equal((await rowOf(unmoved.rowId)).status, 'paid');
  assert.deepEqual(
    state.sends.slice(4).map((send) => send.idempotencyKey),
    [unmoved.key],
  );
  assert.equal(new Set(state.sends.map((send) => send.idempotencyKey)).size, 2);
  assert.equal((await postingsOf(tip.tipId)).length, 1);
  assert.equal((await postingsOf(unmoved.tipId)).length, 1);
});

test('insufficient balance waits and retries; an hour waiting raises one stuck issue', async () => {
  await verified(TOBI);
  const tip = await paidTip(TOBI);
  assert.equal(await release(T0), 1);
  const { provider, state } = partner();
  // Refused at T0, 5 min, 61 min, 2 h and 3 h; paid at 10 h.
  for (let i = 0; i < 5; i += 1) state.answers.push({ refuse: 'insufficient' });
  const first = await run(provider, T0);
  assert.equal(first.retried, 1);
  let row = await rowOf(tip.rowId);
  assert.equal(row.status, 'ready');
  // 5 minutes, then doubling.
  assert.deepEqual(row.next_try_at, at(5 * MIN));
  await run(provider, at(4 * MIN));
  assert.equal(state.sends.length, 1);
  await run(provider, at(5 * MIN));
  assert.equal(state.sends.length, 2);
  row = await rowOf(tip.rowId);
  assert.deepEqual(row.next_try_at, at(15 * MIN));
  assert.deepEqual(await issuesOf('collect_transfer_stuck'), []);
  // Over an hour since it was first tried, still ready: one issue, however many runs see it.
  await run(provider, at(61 * MIN));
  await run(provider, at(2 * HOUR));
  await run(provider, at(3 * HOUR));
  const stuck = await issuesOf('collect_transfer_stuck');
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].status, 'open');
  // Every try used the same key.
  assert.deepEqual(
    new Set(state.sends.map((send) => send.idempotencyKey)),
    new Set([tip.key]),
  );
  // The balance is funded again: paid, once.
  await run(provider, at(10 * HOUR));
  assert.equal((await rowOf(tip.rowId)).status, 'paid');
  assert.equal((await postingsOf(tip.tipId)).length, 1);
  assert.equal((await issuesOf('collect_transfer_stuck')).length, 1);
});

test('the wait after insufficient balance doubles to at most 6 hours', async () => {
  await verified(TOBI);
  const tip = await paidTip(TOBI);
  assert.equal(await release(T0), 1);
  const { provider, state } = partner();
  let now = T0;
  const waits = [];
  for (let i = 0; i < 9; i += 1) {
    state.answers.push({ refuse: 'insufficient' });
    await run(provider, now);
    const { next_try_at: next } = await rowOf(tip.rowId);
    waits.push((next.getTime() - now.getTime()) / MIN);
    now = next;
  }
  assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 320, 360, 360]);
});

/** A capability event, as the adapter normalises it. */
const capabilityEvent = () => ({
  kind: 'account',
  eventId: `evt_${randomUUID()}`,
  eventType: 'capability.updated',
  accountReference: ACCOUNTS[TOBI.id],
});

test('a lost capability sends the share back to waiting, and capability.updated releases it', async () => {
  await verified(TOBI);
  const one = await paidTip(TOBI);
  const two = await paidTip(TOBI);
  assert.equal(await release(T0), 2);
  const { provider, state } = partner();
  state.capability = 'restricted';
  state.answers.push({ refuse: 'capability' });
  const result = await run(provider, T0);
  // The recipient's account can't receive: both shares wait, one call told us so.
  assert.equal(state.sends.length, 1);
  assert.deepEqual(state.capabilityReads, [ACCOUNTS[TOBI.id]]);
  assert.equal(result.stopped, undefined);
  assert.equal((await rowOf(one.rowId)).status, 'waiting');
  assert.equal((await rowOf(two.rowId)).status, 'waiting');
  // The sweep does not hand it straight back.
  assert.equal(await release(at(MIN)), 0);
  const webhooks = new WebhookService({ db: database.db }, sealing, {
    warn() {},
  });
  const account = {
    environment: 'sandbox',
    name: 'bachs-sandbox',
    async getRecipientAccount(reference) {
      return {
        accountReference: reference,
        active: true,
        feeCollector: 'platform',
        requirementsDue: [],
      };
    },
    payoutCapability: (reference) => provider.payoutCapability(reference),
  };
  // The partner sent "active" (older) and then "restricted" (newer), and delivers the newer first.
  // Each delivery re-reads the account, which is restricted now: neither releases anything, and
  // the older one arriving last can't undo the newer.
  const older = capabilityEvent();
  const newer = capabilityEvent();
  assert.equal(await webhooks.applyBachs(newer, account), 'account_refreshed');
  assert.equal(await webhooks.applyBachs(older, account), 'account_refreshed');
  assert.equal((await rowOf(one.rowId)).status, 'waiting');
  assert.equal((await rowOf(two.rowId)).status, 'waiting');
  // Active again: the next event releases both, and the run pays them.
  state.capability = 'active';
  assert.equal(
    await webhooks.applyBachs(capabilityEvent(), account),
    'account_refreshed',
  );
  assert.equal((await rowOf(one.rowId)).status, 'ready');
  await run(provider, new Date(Date.now() + MIN));
  assert.equal((await rowOf(one.rowId)).status, 'paid');
  assert.equal((await rowOf(two.rowId)).status, 'paid');
  assert.deepEqual(
    state.sends.map((send) => send.idempotencyKey),
    [one.key, one.key, two.key],
  );
});

test('FORBIDDEN while the recipient can receive is TipMe’s own problem: the run stops with one issue, and nobody goes back to waiting', async () => {
  await verified(TOBI);
  await verified(ADA);
  const tobi = await paidTip(TOBI);
  const ada = await paidTip(ADA);
  assert.equal(await release(T0), 2);
  const { provider, state } = partner();
  // The recipient's capability reads active, yet the send is refused: TipMe's key lost transfers.
  state.answers.push({ refuse: 'capability' }, { refuse: 'capability' });
  const first = await run(provider, T0);
  assert.equal(first.stopped, 'platform');
  assert.equal(state.sends.length, 1);
  assert.equal(state.capabilityReads.length, 1);
  assert.equal((await rowOf(tobi.rowId)).status, 'ready');
  assert.equal((await rowOf(ada.rowId)).status, 'ready');
  // A later run hits it again: still one issue.
  await run(provider, at(10 * MIN));
  const platform = await issuesOf('collect_transfer_stuck');
  assert.equal(platform.length, 1);
  assert.match(platform[0].dedupe_key, /^collect_transfer_stuck\.platform\./);
  assert.equal((await rowOf(tobi.rowId)).status, 'ready');
  assert.equal((await rowOf(ada.rowId)).status, 'ready');
  // The key is fixed: both move, each with its own key.
  await run(provider, at(HOUR));
  assert.equal((await rowOf(tobi.rowId)).status, 'paid');
  assert.equal((await rowOf(ada.rowId)).status, 'paid');
});

test('in-debt stops every collect transfer with one issue', async () => {
  await verified(TOBI);
  await verified(ADA);
  const tips = [await paidTip(TOBI), await paidTip(TOBI), await paidTip(ADA)];
  assert.equal(await release(T0), 3);
  const { provider, state } = partner();
  state.answers.push({ refuse: 'in_debt' });
  const first = await run(provider, T0);
  assert.equal(first.stopped, 'in_debt');
  // The first refusal stops the whole run: nothing else is tried.
  assert.equal(state.sends.length, 1);
  for (const tip of tips)
    assert.equal((await rowOf(tip.rowId)).status, 'ready');
  let debt = await issuesOf('collect_in_debt');
  assert.equal(debt.length, 1);
  // Later runs stay stopped while the issue is open, without asking the partner.
  const later = await run(provider, at(HOUR));
  assert.equal(later.stopped, 'in_debt');
  assert.equal(state.sends.length, 1);
  assert.equal((await issuesOf('collect_in_debt')).length, 1);
  // Staff resolve it (TipMe topped up): every share moves.
  const [{ id }] = await q(
    `SELECT id FROM issues WHERE kind = 'collect_in_debt'`,
  );
  assert.equal(await resolve(id), true);
  const resumed = await run(provider, at(4 * HOUR));
  assert.equal(resumed.stopped, undefined);
  assert.equal(resumed.paid, 3);
  // A new debt later opens a new issue: a closed one never swallows the next.
  const next = await paidTip(TOBI, at(5 * HOUR));
  assert.equal(await release(at(5 * HOUR)), 1);
  state.answers.push({ refuse: 'in_debt' });
  assert.equal((await run(provider, at(5 * HOUR))).stopped, 'in_debt');
  debt = await issuesOf('collect_in_debt');
  assert.deepEqual(
    debt.map((issue) => issue.status),
    ['resolved', 'open'],
  );
  assert.equal((await rowOf(next.rowId)).status, 'ready');
});

test('not found or a different amount goes to review with a money issue and no posting', async () => {
  await verified(TOBI);
  const notFound = await paidTip(TOBI);
  const refused = await paidTip(TOBI);
  const different = await paidTip(TOBI);
  assert.equal(await release(T0), 3);
  const { provider, state } = partner();
  state.answers.push(
    { refuse: 'not_found' },
    { refuse: 'other' },
    { moveMinor: NET + 1n },
  );
  const first = await run(provider, T0);
  assert.equal(first.review, 2);
  for (const tip of [notFound, refused]) {
    const row = await rowOf(tip.rowId);
    assert.equal(row.status, 'review');
    assert.equal(row.review_reason, 'provider');
  }
  // The partner answered with another amount: uncertain, then read back after 24 hours.
  assert.equal((await rowOf(different.rowId)).status, 'unknown');
  await run(provider, at(25 * HOUR));
  const row = await rowOf(different.rowId);
  assert.equal(row.status, 'review');
  assert.equal(row.review_reason, 'provider');
  for (const tip of [notFound, refused, different])
    assert.deepEqual(await postingsOf(tip.tipId), []);
  const review = await issuesOf('collect_transfer_review');
  assert.deepEqual(
    review.map((issue) => issue.subject.tipId).sort(),
    [notFound.tipId, refused.tipId, different.tipId].sort(),
  );
  // In review, nothing is sent again.
  const sends = state.sends.length;
  await run(provider, at(30 * HOUR));
  assert.equal(state.sends.length, sends);
});

test('a crashed claim read back with another amount goes to review, with no posting', async () => {
  await verified(TOBI);
  const tip = await paidTip(TOBI);
  assert.equal(await release(T0), 1);
  const { provider, state } = partner();
  state.moved.set(tip.key, {
    transferRef: 'tr_odd',
    status: 'paid',
    amountMinor: NET - 1n,
    currency: 'NGN',
    group: tip.key,
    accountRef: ACCOUNTS[TOBI.id],
  });
  await crashedAfterClaim(tip.rowId, T0);
  const result = await run(provider, at(5 * MIN));
  assert.equal(result.review, 1);
  assert.equal(state.sends.length, 0);
  assert.equal((await rowOf(tip.rowId)).review_reason, 'provider');
  assert.deepEqual(await postingsOf(tip.tipId), []);
  assert.equal((await issuesOf('collect_transfer_review')).length, 1);
});

test("a recipient's backlog moves oldest first, five per run", async () => {
  await verified(TOBI);
  await verified(ADA);
  const backlog = [];
  for (let i = 0; i < 7; i += 1) backlog.push(await paidTip(TOBI));
  const ada = await paidTip(ADA);
  // The tips' own times decide the order, not the rows': the last made is the oldest tip.
  const order = [...backlog].reverse();
  for (const [i, tip] of order.entries())
    await q(`UPDATE tips SET created_at = $2 WHERE id = $1`, [
      tip.tipId,
      at(-DAY + i * MIN),
    ]);
  assert.equal(await release(T0), 8);
  const { provider, state } = partner();
  const first = await run(provider, T0);
  assert.equal(first.paid, 6);
  const tobiSends = () =>
    state.sends
      .filter((send) => send.accountRef === ACCOUNTS[TOBI.id])
      .map((send) => send.idempotencyKey);
  assert.deepEqual(
    tobiSends(),
    order.slice(0, 5).map((tip) => tip.key),
  );
  assert.equal((await rowOf(ada.rowId)).status, 'paid');
  const second = await run(provider, at(2 * MIN));
  assert.equal(second.paid, 2);
  assert.deepEqual(
    tobiSends(),
    order.map((tip) => tip.key),
  );
  // A smaller limit is honoured too.
  assert.equal(
    (await run(provider, at(4 * MIN), { perRecipientPerRun: 1 })).paid,
    0,
  );
});

/** A settings row (spec §9's defaults), paused or not, in force from `from`. */
const settings = (paused, from) =>
  q(
    `INSERT INTO collect_settings (id, cap_minor, cap_days, reminder_days, delay_hours, delay_for_days,
       first_withdrawal_cap_minor, new_daily_limit_minor, new_daily_limit_days, reserve_warning_minor,
       reserve_critical_minor, paused, effective_from, reason)
     VALUES ($1, 5000000, 30, '{7,21,28}', 24, 7, 5000000, 20000000, 30, 50000000, 25000000, $2, $3,
             'Set by a test')`,
    [randomUUID(), paused, from],
  );

test('paused settings stop the run; resuming continues from where it stopped', async () => {
  await verified(TOBI);
  const one = await paidTip(TOBI);
  const two = await paidTip(TOBI);
  assert.equal(await release(T0), 2);
  const { provider, state } = partner();
  // One went out and its answer was lost before staff paused.
  state.answers.push('lost');
  await run(provider, T0, { perRecipientPerRun: 1 });
  assert.equal((await rowOf(one.rowId)).status, 'unknown');
  await settings(true, at(MIN));
  const paused = await run(provider, at(10 * MIN));
  assert.equal(paused.stopped, 'paused');
  assert.equal(state.sends.length, 1);
  assert.equal(state.lists.length, 0);
  assert.equal((await rowOf(two.rowId)).status, 'ready');
  // Resumed: the lost one is asked again with its key, the other goes out.
  await settings(false, at(20 * MIN));
  const resumed = await run(provider, at(30 * MIN));
  assert.equal(resumed.stopped, undefined);
  assert.equal((await rowOf(one.rowId)).status, 'paid');
  assert.equal((await rowOf(two.rowId)).status, 'paid');
  assert.deepEqual(
    state.sends.map((send) => send.idempotencyKey),
    [one.key, one.key, two.key],
  );
  assert.equal((await postingsOf(one.tipId)).length, 1);
});

test('with the switch off, held shares still move', async () => {
  await verified(TOBI);
  const tip = await paidTip(TOBI);
  await setSwitch(database.pool, 'you_collect', false);
  assert.equal(await release(T0), 1);
  const { provider } = partner();
  assert.equal((await run(provider, T0)).paid, 1);
  assert.equal((await rowOf(tip.rowId)).status, 'paid');
});

test('only a provider or staff review is retried, to ready with an account or waiting without (P13, P20)', async () => {
  await verified(TOBI);
  const provider = await paidTip(TOBI);
  const staff = await paidTip(TOBI);
  const dispute = await paidTip(TOBI);
  const sameBank = await paidTip(TOBI);
  // A share held by staff before it had an account; and reviews for each reason.
  assert.equal(
    await ops.holdCollectTransfer(database.db, {
      transferId: staff.rowId,
      now: T0,
    }),
    true,
  );
  assert.equal(await release(T0), 3);
  await q(
    `UPDATE collect_transfers SET status = 'review', review_reason = $2 WHERE id = $1`,
    [provider.rowId, 'provider'],
  );
  await q(
    `UPDATE collect_transfers SET status = 'review', review_reason = $2 WHERE id = $1`,
    [dispute.rowId, 'dispute'],
  );
  await q(
    `UPDATE collect_transfers SET status = 'review', review_reason = $2 WHERE id = $1`,
    [sameBank.rowId, 'same_bank'],
  );
  const staffRow = await rowOf(staff.rowId);
  assert.equal(staffRow.status, 'review');
  assert.equal(staffRow.review_reason, 'staff');
  assert.equal(staffRow.account_reference, null);
  const retry = (tip) =>
    ops.retryCollectTransfer(database.db, {
      transferId: tip.rowId,
      now: at(MIN),
    });
  assert.equal(await retry(provider), 'ready');
  assert.equal(await retry(staff), 'waiting');
  assert.equal(await retry(dispute), 'refused');
  assert.equal(await retry(sameBank), 'refused');
  assert.equal(await retry(provider), 'refused');
  const after = await rowOf(provider.rowId);
  assert.equal(after.status, 'ready');
  assert.equal(after.review_reason, null);
  assert.equal((await rowOf(dispute.rowId)).status, 'review');
  // A share in flight is never held by hand: its money may be moving.
  await crashedAfterClaim(provider.rowId, T0);
  assert.equal(
    await ops.holdCollectTransfer(database.db, {
      transferId: provider.rowId,
      now: T0,
    }),
    false,
  );
});

test('a share sent before is read back by group before it is sent again once its key is forgotten', async () => {
  await verified(TOBI);
  const moved = await paidTip(TOBI);
  const unmoved = await paidTip(TOBI);
  assert.equal(await release(T0), 2);
  const { provider, state } = partner();
  // Both went to review on a refusal; one of them had in fact moved (the partner's records are
  // what count), the other had not.
  state.answers.push({ refuse: 'other' }, { refuse: 'other' });
  assert.equal((await run(provider, T0)).review, 2);
  state.moved.set(moved.key, {
    transferRef: 'tr_moved',
    status: 'paid',
    amountMinor: NET,
    currency: 'NGN',
    group: moved.key,
    accountRef: ACCOUNTS[TOBI.id],
  });
  // Staff retry both two days later: the partner no longer knows the key, so a send could make a
  // second transfer. Each is read back first.
  for (const tip of [moved, unmoved])
    assert.equal(
      await ops.retryCollectTransfer(database.db, {
        transferId: tip.rowId,
        now: at(2 * DAY),
      }),
      'ready',
    );
  await run(provider, at(2 * DAY));
  assert.equal((await rowOf(moved.rowId)).status, 'paid');
  assert.equal((await rowOf(moved.rowId)).transfer_reference, 'tr_moved');
  assert.equal((await rowOf(unmoved.rowId)).status, 'paid');
  assert.deepEqual(
    state.sends.slice(2).map((send) => send.idempotencyKey),
    [unmoved.key],
  );
  assert.equal((await postingsOf(moved.tipId)).length, 1);
  assert.equal((await postingsOf(unmoved.tipId)).length, 1);
});
