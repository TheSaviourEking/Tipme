import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { UncertainProviderOutcomeError } from '../../packages/payments/dist/index.js';
import { setSwitch } from './helpers.mjs';

/*
 * You collect (plan Task 11, spec §7, rulings P17, P18): every day TipMe checks the partner's record
 * against its own. For each recipient with recent You collect activity, the partner's transfers on
 * their account against our `collect_transfers` rows by `transfer_group`; the partner's disputes
 * against ours; and the partner-reported money moves of TipMe's own balance against the ledger.
 * Anything that doesn't match opens one money issue each. No partner is called: a fake answers.
 */

const [ADA, TOBI] = ops.DEMO_PROFILES;
const GROSS = 1_000_000n;
const NET = 950_000n;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const T0 = new Date(Math.floor(Date.now() / MIN) * MIN - DAY);
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

async function paidTip(profile, settledAt = T0) {
  const { db } = database;
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
    rowId: row.id,
    key: `tipme-collect-${intent.tipId}`,
    chargeReference,
  };
}

/** The partner: what it moved, and what it lists on each account (scripted by each test). */
function partner() {
  const state = { listed: [], disputes: [], unreadable: new Set() };
  const provider = {
    name: 'bachs-sandbox',
    async sendCollectTransfer(input) {
      const transfer = {
        transferRef: `tr_${state.listed.length + 1}`,
        status: 'paid',
        amountMinor: input.amountMinor,
        currency: input.currency,
        group: input.idempotencyKey,
        accountRef: input.accountRef,
      };
      state.listed.push(transfer);
      return { transferRef: transfer.transferRef, status: 'paid' };
    },
    async listAccountTransfers(accountRef) {
      if (state.unreadable.has(accountRef))
        throw new UncertainProviderOutcomeError(
          `transfers.${accountRef}`,
          'unreadable',
          { cause: 'unreadable_response' },
        );
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
    async listDisputes(since) {
      assert.ok(since instanceof Date);
      state.since = since;
      // As the partner's `from_date`: only disputes created since then (review I3).
      return state.disputes.filter((d) => !d.createdAt || d.createdAt >= since);
    },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
  };
  return { provider, state };
}

const recon = (provider, day = new Date()) =>
  ops.reconcileCollect(database.db, { provider, day });
const mismatches = () =>
  q(
    `SELECT dedupe_key, summary, subject FROM issues
      WHERE kind = 'collect_recon_mismatch' ORDER BY dedupe_key`,
  );

test('recon finds a missing, an extra and a different-amount transfer, and matches the rest', async () => {
  await verified(TOBI);
  const { provider, state } = partner();
  const tips = [];
  for (let i = 0; i < 4; i += 1) tips.push(await paidTip(TOBI));
  await ops.releaseWaitingTransfers(database.db, { now: T0 });
  await ops.runCollectTransfers(database.db, { provider, now: T0 });
  const paid = await q(
    `SELECT count(*)::int AS n FROM collect_transfers WHERE kind = 'share' AND status = 'paid'`,
  );
  assert.equal(paid[0].n, 4);

  // Everything agrees: nothing to raise.
  assert.deepEqual(await recon(provider), {
    checked: 4,
    mismatches: 0,
    unreadable: 0,
  });
  assert.deepEqual(await mismatches(), []);

  // The partner lost one, shows another with a different amount, and lists one we never made.
  const [missing, different] = tips;
  state.listed = state.listed.filter((t) => t.group !== missing.key);
  state.listed.find((t) => t.group === different.key).amountMinor = NET - 1n;
  const strayKey = `tipme-collect-${randomUUID()}`;
  state.listed.push({
    transferRef: 'tr_stray',
    status: 'paid',
    amountMinor: 12_300n,
    currency: 'NGN',
    group: strayKey,
    accountRef: ACCOUNTS[TOBI.id],
  });
  // A transfer that isn't TipMe's You collect (no tipme-collect- group) is not ours to judge.
  state.listed.push({
    transferRef: 'tr_other',
    status: 'paid',
    amountMinor: 500n,
    currency: 'NGN',
    group: null,
    accountRef: ACCOUNTS[TOBI.id],
  });
  const result = await recon(provider);
  assert.equal(result.mismatches, 3);
  assert.equal(result.checked, 5);
  const raised = await mismatches();
  assert.equal(raised.length, 3);
  const byGroup = (key) => raised.find((r) => r.summary.includes(key));
  assert.match(byGroup(missing.key).summary, /not listed/);
  assert.equal(byGroup(missing.key).subject.tipId, missing.tipId);
  assert.match(byGroup(different.key).summary, /₦9,499\.99/);
  assert.match(byGroup(different.key).summary, /₦9,500/);
  assert.match(byGroup(strayKey).summary, /no record/);
  assert.equal(byGroup(strayKey).subject.profileId, TOBI.id);

  // Run again: the same three, one issue each.
  assert.equal((await recon(provider)).mismatches, 3);
  assert.equal((await mismatches()).length, 3);
});

test('a recipient whose transfers cannot be read is counted, and the others are still checked', async () => {
  await verified(TOBI);
  await verified(ADA);
  const { provider, state } = partner();
  await paidTip(TOBI);
  await paidTip(ADA);
  await ops.releaseWaitingTransfers(database.db, { now: T0 });
  await ops.runCollectTransfers(database.db, { provider, now: T0 });
  state.unreadable.add(ACCOUNTS[ADA.id]);
  assert.deepEqual(await recon(provider), {
    checked: 1,
    mismatches: 0,
    unreadable: 1,
  });
});

test('recipients with no You collect activity in the last 3 days are not read', async () => {
  await verified(TOBI);
  const { provider } = partner();
  await paidTip(TOBI);
  await ops.releaseWaitingTransfers(database.db, { now: T0 });
  await ops.runCollectTransfers(database.db, { provider, now: T0 });
  await q(
    `UPDATE collect_transfers SET created_at = now() - interval '5 days', updated_at = now() - interval '5 days'`,
  );
  let reads = 0;
  const counting = {
    ...provider,
    async listAccountTransfers(accountRef) {
      reads += 1;
      return provider.listAccountTransfers(accountRef);
    },
  };
  assert.equal((await recon(counting)).checked, 0);
  assert.equal(reads, 0);
});

const disputeEvent = (tip, partnerDisputeId, status = 'open') => ({
  kind: 'dispute',
  eventId: `evt_${randomUUID()}`,
  eventType: status === 'open' ? 'dispute.created' : 'dispute.updated',
  scope: 'platform',
  partnerDisputeId,
  chargeReference: tip.chargeReference,
  providerReference: null,
  operationReference: null,
  status,
  amountMinor: GROSS,
  currency: 'NGN',
  reason: 'fraudulent',
  respondBy: new Date(Date.now() + 7 * DAY),
  feeMinor: 1_500n,
  feeCurrency: 'USD',
  occurredAt: new Date(),
});

test("recon matches partner disputes to ours and flags one we don't know", async () => {
  const { provider, state } = partner();
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    TOBI.id,
  ]);
  const known = await paidTip(TOBI);
  const unknown = await paidTip(TOBI);
  const knownId = `dp_${randomUUID().slice(0, 10)}`;
  await ops.applyDisputeEvent(database.db, {
    event: disputeEvent(known, knownId),
    provider: 'bachs',
    now: new Date(),
  });
  const listed = (tip, partnerDisputeId, over = {}) => ({
    partnerDisputeId,
    status: 'open',
    amountMinor: GROSS,
    currency: 'NGN',
    chargeReference: tip.chargeReference,
    ...over,
  });
  state.disputes = [listed(known, knownId)];
  assert.equal((await recon(provider)).mismatches, 0);

  // One the partner has on a collect tip that never reached TipMe (a lost webhook), and one on a
  // charge that isn't You collect's (a Pro payment's, P5): only the first is ours to flag.
  const missedId = `dp_${randomUUID().slice(0, 10)}`;
  state.disputes = [
    listed(known, knownId),
    listed(unknown, missedId),
    {
      partnerDisputeId: 'dp_pro_payment',
      status: 'open',
      amountMinor: 500_000n,
      currency: 'NGN',
      chargeReference: 'ch_not_collect',
    },
  ];
  const result = await recon(provider);
  assert.equal(result.mismatches, 1);
  const [raised] = await mismatches();
  assert.match(raised.summary, new RegExp(missedId));
  assert.equal(raised.subject.tipId, unknown.tipId);

  // The same dispute with another amount than ours is a mismatch too.
  state.disputes = [listed(known, knownId, { amountMinor: GROSS - 100n })];
  assert.equal((await recon(provider)).mismatches, 1);
  assert.equal((await mismatches()).length, 2);
});

test('P18: a dispute fee the partner charged that the ledger does not have is a mismatch', async () => {
  const { provider, state } = partner();
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    TOBI.id,
  ]);
  const tip = await paidTip(TOBI);
  const partnerDisputeId = `dp_${randomUUID().slice(0, 10)}`;
  // Reported with its fee: booked once (dispute_fee.<id>), so the books agree.
  await ops.applyDisputeEvent(database.db, {
    event: disputeEvent(tip, partnerDisputeId),
    provider: 'bachs',
    now: new Date(),
  });
  state.disputes = [
    {
      partnerDisputeId,
      status: 'open',
      amountMinor: GROSS,
      currency: 'NGN',
      chargeReference: tip.chargeReference,
    },
  ];
  assert.equal((await recon(provider)).mismatches, 0);
  // A second dispute whose fee is recorded on the row but was never booked (as if hand-edited, or
  // a booking lost): TipMe's balance paid it, the ledger doesn't say so.
  const other = await paidTip(TOBI);
  const otherId = `dp_${randomUUID().slice(0, 10)}`;
  await ops.applyDisputeEvent(database.db, {
    event: {
      ...disputeEvent(other, otherId),
      feeMinor: null,
      feeCurrency: null,
    },
    provider: 'bachs',
    now: new Date(),
  });
  await q(
    `UPDATE disputes SET fee_minor = 1500, fee_currency = 'USD' WHERE partner_dispute_id = $1`,
    [otherId],
  );
  state.disputes.push({
    partnerDisputeId: otherId,
    status: 'open',
    amountMinor: GROSS,
    currency: 'NGN',
    chargeReference: other.chargeReference,
  });
  assert.equal((await recon(provider)).mismatches, 1);
  const [raised] = await mismatches();
  assert.match(raised.summary, new RegExp(otherId));
  assert.match(raised.summary, /15\.00 USD/);
  assert.equal(raised.subject.tipId, other.tipId);
});

test('a tip is fully reconciled once its payment is verified, its share paid with its posting, and no dispute is open', async () => {
  await verified(TOBI);
  const { provider } = partner();
  const tip = await paidTip(TOBI);
  const before = await ops.collectTipReconciliation(database.db, tip.tipId);
  assert.equal(before.reconciled, false);
  assert.deepEqual(before.waiting, ['share']);
  await ops.releaseWaitingTransfers(database.db, { now: T0 });
  await ops.runCollectTransfers(database.db, { provider, now: T0 });
  const done = await ops.collectTipReconciliation(database.db, tip.tipId);
  assert.deepEqual(done, { reconciled: true, waiting: [] });
  await ops.applyDisputeEvent(database.db, {
    event: disputeEvent(tip, `dp_${randomUUID().slice(0, 10)}`),
    provider: 'bachs',
    now: new Date(),
  });
  const disputed = await ops.collectTipReconciliation(database.db, tip.tipId);
  assert.equal(disputed.reconciled, false);
  assert.deepEqual(disputed.waiting, ['dispute']);
});

/* Fix round 1 (review I2, I3, m2). */

test('I2: a share the partner sent twice under one group is a mismatch', async () => {
  await verified(TOBI);
  const { provider, state } = partner();
  const tip = await paidTip(TOBI);
  await ops.releaseWaitingTransfers(database.db, { now: T0 });
  await ops.runCollectTransfers(database.db, { provider, now: T0 });
  assert.equal((await recon(provider)).mismatches, 0);
  // Probe B: the same group listed twice, two transfer ids.
  const first = state.listed.find((t) => t.group === tip.key);
  state.listed.push({ ...first, transferRef: 'tr_again' });
  const result = await recon(provider);
  assert.equal(result.mismatches, 1);
  const [raised] = await mismatches();
  assert.match(raised.dedupe_key, /duplicate/);
  assert.match(raised.summary, /tr_again/);
  assert.match(raised.summary, new RegExp(tip.key));
  assert.equal(raised.subject.tipId, tip.tipId);
});

test('I3, m2: a dispute opened weeks ago is still compared, and a ruling TipMe missed is raised', async () => {
  const { provider, state } = partner();
  await q(`UPDATE profiles SET collection_mode = 'collect' WHERE id = $1`, [
    TOBI.id,
  ]);
  const tip = await paidTip(TOBI);
  const partnerDisputeId = `dp_${randomUUID().slice(0, 10)}`;
  await ops.applyDisputeEvent(database.db, {
    event: disputeEvent(tip, partnerDisputeId),
    provider: 'bachs',
    now: new Date(),
  });
  // Opened 30 days ago; its lost webhook never arrived.
  const opened = new Date(Date.now() - 30 * DAY);
  await q(`UPDATE disputes SET created_at = $2 WHERE partner_dispute_id = $1`, [
    partnerDisputeId,
    opened,
  ]);
  state.disputes = [
    {
      partnerDisputeId,
      status: 'lost',
      amountMinor: GROSS,
      currency: 'NGN',
      chargeReference: tip.chargeReference,
      createdAt: opened,
    },
  ];
  const result = await recon(provider);
  assert.ok(state.since <= opened);
  assert.equal(result.mismatches, 1);
  const [raised] = await mismatches();
  assert.match(raised.summary, /lost at the partner and open/);
  // m2: another amount as well is a second finding, not hidden by the first.
  state.disputes[0].amountMinor = GROSS - 100n;
  assert.equal((await recon(provider)).mismatches, 2);
  assert.equal((await mismatches()).length, 2);
});
