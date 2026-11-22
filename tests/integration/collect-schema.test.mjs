import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import * as ops from '../../packages/database/dist/index.js';
import { postLedgerTransaction } from '../../packages/database/dist/operations/ledger.js';
import {
  buildAbsorbedRefundPosting,
  buildCollectPaymentPosting,
  buildCollectRefundPosting,
  buildCollectTransferPosting,
  buildDisputeFeePosting,
  buildDisputeLossPosting,
  buildPaymentPosting,
  buildReversalPosting,
} from '../../packages/domain/dist/index.js';
import { seedBusiness } from '../../packages/database/test/integration/business-fixtures.mjs';

// You collect, plan Task 3 (ADR-0016, PROPOSED): the schema, the inert switch and the settings
// reader. The database itself refuses what the model forbids, so no later task can write a collect
// transfer, a dispute, a setting or a held amount wrongly. Nothing here moves money: postings go
// straight through postLedgerTransaction, and the switch is off (it starts off everywhere).

const REASON = 'Agreed with the owner on the call today';
const ADA = ops.DEMO_PROFILES[0];
// ₦10,000 on Free 5%: TipMe's fee ₦350 plus ₦150 recovered processing, Ada's net ₦9,500, and the
// partner keeps ₦200 (a Nigerian card at 2%).
const GROSS = 1_000_000n;
const FEE = 35_000n;
const QUOTED = 15_000n;
const NET = 950_000n;
const ACTUAL = 20_000n;

let database;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);
const refused = (promise, name) =>
  assert.rejects(promise, (error) => {
    // A commit-time refusal (the deferred ledger triggers) comes wrapped by drizzle.
    assert.match(
      String(error.constraint ?? error.cause?.constraint ?? error.message),
      name,
    );
    return true;
  });

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
});
after(async () => {
  await database?.close();
});

/** A tip to Ada as the code makes one today (no payment yet). */
async function newTip() {
  const quote = await ops.createQuote(database.db, {
    handle: 'ada',
    tipMinor: GROSS,
    currency: 'NGN',
  });
  const intent = await ops.createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  return { ...intent, quoteId: quote.quoteId };
}

const post = (input) =>
  database.db.transaction((tx) =>
    postLedgerTransaction(tx, {
      currency: 'NGN',
      traceId: null,
      operationKey: `${input.operationType}.${randomUUID()}`,
      ...input,
    }),
  );

/** A collect tip's payment, booked: held for Ada (and for the business, with a share). */
async function collectPaid(businessShare) {
  const tip = await newTip();
  const { transactionId } = await post({
    operationType: 'payment',
    tipId: tip.tipId,
    lines: buildCollectPaymentPosting({
      grossMinor: GROSS,
      platformFeeMinor: FEE,
      quotedProviderFeeMinor: QUOTED,
      actualProviderFeeMinor: ACTUAL,
      recipientNetMinor: NET,
      profileId: ADA.id,
      ...(businessShare ? { businessShare } : {}),
    }),
  });
  return { ...tip, paymentId: transactionId };
}

const reversal = (paid, lines) =>
  post({
    operationType: 'reversal',
    tipId: paid.tipId,
    reversesTransactionId: paid.paymentId,
    lines,
  });

const settingsRow = (values = {}) =>
  q(
    `INSERT INTO collect_settings (id, cap_minor, cap_days, reminder_days, delay_hours, delay_for_days,
       first_withdrawal_cap_minor, new_daily_limit_minor, new_daily_limit_days, reserve_warning_minor,
       reserve_critical_minor, paused, effective_from, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [
      values.id ?? randomUUID(),
      values.capMinor ?? '5000000',
      values.capDays ?? 30,
      values.reminderDays ?? [7, 21, 28],
      values.delayHours ?? 24,
      values.delayForDays ?? 7,
      values.firstWithdrawalCapMinor ?? '5000000',
      values.newDailyLimitMinor ?? '20000000',
      values.newDailyLimitDays ?? 30,
      values.reserveWarningMinor ?? '50000000',
      values.reserveCriticalMinor ?? '25000000',
      values.paused ?? false,
      values.effectiveFrom ?? new Date(),
      values.reason ?? REASON,
    ],
  ).then(([row]) => row.id);

const transferRow = (values) =>
  q(
    `INSERT INTO collect_transfers (id, kind, tip_id, profile_id, refund_id, dispute_id, account_reference,
       provider, environment, amount_minor, currency, status, idempotency_key, review_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'mock', 'sandbox', $8, 'NGN', $9, $10, $11)`,
    [
      values.id ?? randomUUID(),
      values.kind ?? 'share',
      values.tipId,
      values.profileId ?? ADA.id,
      values.refundId ?? null,
      values.disputeId ?? null,
      values.accountReference ?? null,
      values.amountMinor ?? NET.toString(),
      values.status ?? 'waiting',
      values.idempotencyKey ?? `tipme-collect-${values.tipId}`,
      values.reviewReason ?? null,
    ],
  );

const disputeRow = (tipId) =>
  q(
    `INSERT INTO disputes (id, provider, partner_dispute_id, tip_id, amount_minor, currency, status,
       last_event_at)
     VALUES ($1, 'mock', $2, $3, $4, 'NGN', 'open', now()) RETURNING id`,
    [randomUUID(), `dp_${randomUUID()}`, tipId, GROSS.toString()],
  ).then(([row]) => row.id);

const refundRow = (tipId) =>
  q(
    `INSERT INTO tip_refunds (id, tip_id, status, amount_minor, currency, provider, provider_reference,
       requested_by, reason)
     VALUES ($1, $2, 'REQUESTED', $3, 'NGN', 'mock', $4, $5, $6) RETURNING id`,
    [
      randomUUID(),
      tipId,
      NET.toString(),
      `ref_${randomUUID()}`,
      ADA.userId,
      REASON,
    ],
  ).then(([row]) => row.id);

// Task 16 built it: staff can turn it on (a money switch, so the API asks a second person first;
// feature-switches-api.test.mjs), it starts off, and off is always allowed.
test('you_collect is a money switch, off until staff turn it on, and back off', async () => {
  const [asker, approver] = ops.DEMO_PROFILES;
  assert.equal(await ops.featureOn(database.db, 'you_collect'), false);
  const set = async (on) => {
    const changed = await database.db.transaction((tx) =>
      ops.setFeatureSwitch(tx, {
        key: 'you_collect',
        on,
        staffUserId: asker.userId,
        approvedBy: approver.userId,
        reason: REASON,
        now: new Date(),
      }),
    );
    // As the API does after a change (switches.changed()): this process forgets its cached value.
    ops.invalidateFeatureSwitches();
    return changed;
  };
  assert.deepEqual(await set(true), {
    key: 'you_collect',
    on: true,
    previous: false,
  });
  assert.equal(await ops.featureOn(database.db, 'you_collect'), true);
  await set(false);
  assert.equal(await ops.featureOn(database.db, 'you_collect'), false);
});

test('collect schema refuses what the model forbids', async () => {
  const { tipId } = await newTip();
  // One share transfer per tip.
  await transferRow({ tipId });
  await refused(
    transferRow({ tipId, idempotencyKey: `tipme-collect-${tipId}-again` }),
    /collect_transfers_one_share|collect_transfers_key/,
  );
  await refused(
    transferRow({ tipId: (await newTip()).tipId, idempotencyKey: 'other' }),
    /collect_transfers_key/,
  );
  // A transfer back names exactly one of a refund and a dispute.
  const disputeId = await disputeRow(tipId);
  const refundId = await refundRow(tipId);
  await refused(
    transferRow({
      tipId,
      kind: 'back',
      refundId,
      disputeId,
      idempotencyKey: `tipme-collect-back-${refundId}`,
    }),
    /collect_transfers_back_source/,
  );
  await refused(
    transferRow({
      tipId,
      kind: 'back',
      idempotencyKey: `tipme-collect-back-${randomUUID()}`,
    }),
    /collect_transfers_back_source/,
  );
  await transferRow({
    tipId,
    kind: 'back',
    disputeId,
    accountReference: 'acct_ada',
    status: 'ready',
    idempotencyKey: `tipme-collect-back-${disputeId}`,
  });
  // A status from the model only; review needs its reason (P13); past waiting needs an account (P8).
  const other = (await newTip()).tipId;
  await refused(
    transferRow({
      tipId: other,
      status: 'refused',
      accountReference: 'acct_ada',
    }),
    /collect_transfers_status/,
  );
  await refused(
    transferRow({ tipId: other, status: 'review' }),
    /collect_transfers_review_reason/,
  );
  await refused(
    transferRow({ tipId: other, status: 'review', reviewReason: 'other' }),
    /collect_transfers_review_reason/,
  );
  await refused(
    transferRow({ tipId: other, status: 'ready' }),
    /collect_transfers_account/,
  );
  await transferRow({
    tipId: other,
    status: 'review',
    reviewReason: 'same_bank',
  });
  // Fix round 1: a review row with no account is released back to waiting (ready needs one).
  const held = (await newTip()).tipId;
  await transferRow({ tipId: held, status: 'review', reviewReason: 'dispute' });
  await refused(
    q(`UPDATE collect_transfers SET status = 'ready' WHERE tip_id = $1`, [
      held,
    ]),
    /collect_transfers_account/,
  );
  await q(
    `UPDATE collect_transfers SET status = 'waiting', review_reason = NULL WHERE tip_id = $1`,
    [held],
  );
  const [released] = await q(
    `SELECT status, account_reference FROM collect_transfers WHERE tip_id = $1`,
    [held],
  );
  assert.deepEqual(released, { status: 'waiting', account_reference: null });

  // Only a business_payable or a held amount may belong to a business (R3).
  const { businessId } = await seedBusiness(database);
  await refused(
    q(
      `INSERT INTO ledger_accounts (id, code, kind, currency, business_id)
       VALUES ($1, 'recipient_payable', 'liability', 'NGN', $2)`,
      [randomUUID(), businessId],
    ),
    /ledger_accounts_business_payable/,
  );
  await refused(
    q(
      `INSERT INTO ledger_accounts (id, code, kind, currency) VALUES ($1, 'business_payable', 'liability', 'NGN')`,
      [randomUUID()],
    ),
    /ledger_accounts_business_payable/,
  );

  // Settings are history: never edited or deleted; bounds from spec §9.
  const id = await settingsRow();
  await assert.rejects(
    q(`UPDATE collect_settings SET paused = true WHERE id = $1`, [id]),
    /append-only/,
  );
  await assert.rejects(
    q(`DELETE FROM collect_settings WHERE id = $1`, [id]),
    /append-only/,
  );
  await assert.rejects(q(`TRUNCATE collect_settings`), /append-only|truncate/i);
  await refused(settingsRow({ capDays: 5 }), /collect_settings_cap_days/);
  await refused(
    settingsRow({ capMinor: '999999' }),
    /collect_settings_cap_minor/,
  );
  await refused(
    settingsRow({ reminderDays: [7, 30] }),
    /collect_settings_reminder_days/,
  );
  await refused(settingsRow({ delayHours: 73 }), /collect_settings_delay/);
  await refused(
    settingsRow({
      reserveWarningMinor: '25000000',
      reserveCriticalMinor: '25000000',
    }),
    /collect_settings_reserve/,
  );

  // A collect sweep (R3, P3) brings a business share in from TipMe: a business, no out leg.
  const sweep = (values) =>
    q(
      `INSERT INTO share_transfers (id, tip_id, kind, business_id, profile_id, currency, amount_minor,
         status, provider)
       VALUES ($1, $2, 'collect_sweep', $3, $4, 'NGN', 95000, $5, 'mock')`,
      [randomUUID(), values.tipId, values.businessId, ADA.id, values.status],
    );
  const swept = (await newTip()).tipId;
  await refused(
    sweep({ tipId: swept, businessId: null, status: 'out_paid' }),
    /share_transfers_business/,
  );
  await refused(
    sweep({ tipId: swept, businessId, status: 'waiting' }),
    /share_transfers_one_leg/,
  );
  await sweep({ tipId: swept, businessId, status: 'out_paid' });
  await refused(
    sweep({ tipId: swept, businessId, status: 'out_paid' }),
    /share_transfers_one_sweep/,
  );

  // A dispute's held amount is never negative nor above the disputed amount (R4).
  await refused(
    q(`UPDATE disputes SET held_minor = amount_minor + 1 WHERE id = $1`, [
      disputeId,
    ]),
    /disputes_held/,
  );
  await refused(
    q(`UPDATE disputes SET evidence_state = 'sent' WHERE id = $1`, [disputeId]),
    /disputes_evidence_state/,
  );

  // The collect reserve has its own readings (P9): own money is what is above the held total.
  const reading = (values) =>
    q(
      `INSERT INTO collect_reserve_readings (id, provider, currency, available_minor, held_minor,
         own_minor, warning_minor, critical_minor, level, read_at)
       VALUES ($1, 'mock', 'NGN', $2, $3, $4, 50000000, 25000000, $5, now())`,
      [randomUUID(), values.available, values.held, values.own, values.level],
    );
  await reading({
    available: 90000000,
    held: 10000000,
    own: 80000000,
    level: 'ok',
  });
  await reading({
    available: 10000000,
    held: 20000000,
    own: -10000000,
    level: 'breach',
  });
  await reading({ available: null, held: 20000000, own: null, level: null });
  await refused(
    reading({ available: 90000000, held: 10000000, own: 1, level: 'critical' }),
    /collect_reserve_readings_own/,
  );
  await refused(
    reading({ available: 40000000, held: 0, own: 40000000, level: 'ok' }),
    /collect_reserve_readings_level/,
  );

  // The columns Tasks 12 and 13 need (P4) are there and empty.
  const [ada] = await q(
    `SELECT collection_mode, collect_verified_at, collect_legal_name FROM profiles WHERE id = $1`,
    [ADA.id],
  );
  assert.deepEqual(ada, {
    collection_mode: null,
    collect_verified_at: null,
    collect_legal_name: null,
  });
  await refused(
    q(`UPDATE profiles SET collection_mode = 'escrow' WHERE id = $1`, [ADA.id]),
    /profiles_collection_mode/,
  );
  const [hashIndex] = await q(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'payout_destinations' AND indexdef LIKE '%account_hash%'`,
  );
  assert.ok(hashIndex, 'payout_destinations.account_hash is indexed');
});

test('held_for_recipients may belong to a person or a business and posts through postLedgerTransaction', async () => {
  const { businessId } = await seedBusiness(database);
  const share = 95_000n;
  const paid = await collectPaid({ businessId, amountMinor: share });
  const held = await q(
    `SELECT a.profile_id, a.business_id, a.kind, e.side, e.amount_minor::text AS amount
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = $1 AND a.code = 'held_for_recipients'
      ORDER BY e.amount_minor DESC`,
    [paid.paymentId],
  );
  assert.deepEqual(held, [
    {
      profile_id: ADA.id,
      business_id: null,
      kind: 'asset',
      side: 'debit',
      amount: (NET - share).toString(),
    },
    {
      profile_id: null,
      business_id: businessId,
      kind: 'asset',
      side: 'debit',
      amount: share.toString(),
    },
  ]);
  // The new operations: a transfer on to Ada, and a dispute fee from TipMe's own money.
  await post({
    operationType: 'collect_transfer',
    tipId: paid.tipId,
    lines: buildCollectTransferPosting({
      amountMinor: NET - share,
      profileId: ADA.id,
    }),
  });
  await post({
    operationType: 'dispute_fee',
    tipId: paid.tipId,
    lines: buildDisputeFeePosting({ feeMinor: 150_000n }),
  });
  const [{ n }] = await q(
    `SELECT count(*)::int AS n FROM ledger_transactions WHERE tip_id = $1`,
    [paid.tipId],
  );
  assert.equal(n, 3);
});

// Pre-flight ruling P2: migration 0083's mirror trigger would refuse every collect refund and dispute
// posting. Only a reversal of a payment that held money for someone gains the new lines.
test('a collect reversal now posts, and a direct over-reversal is still refused', async () => {
  // A refund of held money, with a refund fee, then a lost dispute recovering the rest.
  const paid = await collectPaid();
  await reversal(
    paid,
    buildCollectRefundPosting({
      parts: [{ amountMinor: 400_000n, profileId: ADA.id }],
      refundFeeMinor: 5_000n,
    }),
  );
  await reversal(
    paid,
    buildDisputeLossPosting({
      disputedMinor: GROSS,
      recovered: [{ amountMinor: NET - 400_000n, profileId: ADA.id }],
    }),
  );
  // Nothing is left held for Ada on this tip: a further take-back is refused.
  await refused(
    reversal(
      paid,
      buildCollectRefundPosting({
        parts: [{ amountMinor: 1n, profileId: ADA.id }],
      }),
    ),
    /ledger_reversal_within_payment/,
  );
  // TipMe absorbs a refund after the money moved on (§6.1 case 3).
  const moved = await collectPaid();
  await reversal(
    moved,
    buildAbsorbedRefundPosting({ amountMinor: NET, refundFeeMinor: 5_000n }),
  );
  // A held line is only ever taken back (credited), never added to by a reversal.
  await refused(
    reversal(moved, [
      {
        account: 'held_for_recipients',
        profileId: ADA.id,
        side: 'debit',
        amountMinor: 1n,
      },
      { account: 'platform_clearing', side: 'credit', amountMinor: 1n },
    ]),
    /ledger_reversal_within_payment/,
  );
  // TipMe's own money only pays out in a reversal: never a debit on platform_clearing.
  await refused(
    reversal(moved, [
      { account: 'platform_clearing', side: 'debit', amountMinor: 1n },
      { account: 'refund_loss_expense', side: 'credit', amountMinor: 1n },
    ]),
    /ledger_reversal_within_payment/,
  );

  // Direct (today): a payment into Ada's account, unchanged rules.
  const direct = await newTip();
  const lines = buildPaymentPosting({
    grossMinor: GROSS,
    platformFeeMinor: FEE,
    quotedProviderFeeMinor: QUOTED,
    actualProviderFeeMinor: ACTUAL,
    recipientNetMinor: NET,
    profileId: ADA.id,
  });
  const { transactionId } = await post({
    operationType: 'payment',
    tipId: direct.tipId,
    lines,
  });
  const directPaid = { tipId: direct.tipId, paymentId: transactionId };
  // Taking back more than Ada's net is refused, as before.
  await refused(
    reversal(directPaid, [
      {
        account: 'recipient_payable',
        profileId: ADA.id,
        side: 'debit',
        amountMinor: NET + 1n,
      },
      { account: 'provider_clearing', side: 'credit', amountMinor: NET + 1n },
    ]),
    /ledger_reversal_within_payment/,
  );
  // The collect-only lines stay refused on a direct payment's reversal.
  await refused(
    reversal(directPaid, [
      {
        account: 'recipient_payable',
        profileId: ADA.id,
        side: 'debit',
        amountMinor: 1_000n,
      },
      { account: 'platform_clearing', side: 'credit', amountMinor: 1_000n },
    ]),
    /ledger_reversal_within_payment/,
  );
  await refused(
    reversal(directPaid, [
      { account: 'dispute_loss_expense', side: 'debit', amountMinor: 1_000n },
      { account: 'provider_clearing', side: 'credit', amountMinor: 1_000n },
    ]),
    /ledger_reversal_within_payment/,
  );
  // A direct payment held nothing, so its reversal can't credit held_for_recipients, for a person
  // or for a business.
  const { businessId } = await seedBusiness(database);
  for (const owner of [{ profileId: ADA.id }, { businessId }])
    await refused(
      reversal(directPaid, [
        {
          account: 'recipient_payable',
          profileId: ADA.id,
          side: 'debit',
          amountMinor: 1_000n,
        },
        {
          account: 'held_for_recipients',
          ...owner,
          side: 'credit',
          amountMinor: 1_000n,
        },
      ]),
      /ledger_reversal_within_payment/,
    );
  // And a full chargeback still posts, then nothing more.
  await reversal(
    directPaid,
    buildReversalPosting(lines, { refundedMinor: GROSS }),
  );
  await refused(
    reversal(directPaid, [
      {
        account: 'recipient_payable',
        profileId: ADA.id,
        side: 'debit',
        amountMinor: 1n,
      },
      { account: 'provider_clearing', side: 'credit', amountMinor: 1n },
    ]),
    /ledger_reversal_within_payment/,
  );
});

test("collect settings fall back to the spec's defaults with no row", async () => {
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  const expected = {
    capMinor: 5_000_000n,
    capDays: 30,
    reminderDays: [7, 21, 28],
    delayHours: 24,
    delayForDays: 7,
    firstWithdrawalCapMinor: 5_000_000n,
    newDailyLimitMinor: 20_000_000n,
    newDailyLimitDays: 30,
    reserveWarningMinor: 50_000_000n,
    reserveCriticalMinor: 25_000_000n,
    paused: false,
  };
  assert.deepEqual({ ...ops.COLLECT_DEFAULTS }, expected);
  const none = await ops.collectSettingsInForce(database.db);
  assert.equal(none.source, 'default');
  for (const [key, value] of Object.entries(expected))
    assert.deepEqual(none[key], value, key);
  // A stored row in force wins; one dated later doesn't apply yet.
  await settingsRow({ capDays: 45, reminderDays: [10, 40], paused: true });
  await settingsRow({
    capDays: 90,
    effectiveFrom: new Date(Date.now() + 86_400_000),
  });
  const stored = await ops.collectSettingsInForce(database.db);
  assert.equal(stored.source, 'setting');
  assert.equal(stored.capDays, 45);
  assert.deepEqual(stored.reminderDays, [10, 40]);
  assert.equal(stored.capMinor, 5_000_000n);
  assert.equal(stored.paused, true);
});

test('an existing quote reads collection_mode direct', async () => {
  const { quoteId } = await newTip();
  const [row] = await q(
    `SELECT collection_mode FROM tip_quotes WHERE id = $1`,
    [quoteId],
  );
  assert.equal(row.collection_mode, 'direct');
  await refused(
    q(
      `INSERT INTO tip_quotes (id, profile_id, currency, tip_minor, platform_fee_minor, provider_fee_minor,
         payer_total_minor, recipient_net_minor, fee_policy_version, expires_at, collection_mode)
       SELECT gen_random_uuid(), profile_id, currency, tip_minor, platform_fee_minor, provider_fee_minor,
         payer_total_minor, recipient_net_minor, fee_policy_version, expires_at, 'escrow'
         FROM tip_quotes WHERE id = $1`,
      [quoteId],
    ),
    /tip_quotes_collection_mode/,
  );
});
