import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import * as ops from '../../packages/database/dist/index.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { newUser, signUpRoute } from './collect-checkout-support.mjs';
import { DIRECT_CASES, owner } from './collect-direct-cases.mjs';

/*
 * You collect with the switch off (plan Task 16, spec §12.4 and §12.5, Review Focus 4). Staff turn
 * the switch on and off again through the real path (`setFeatureSwitch`, with a second person), and
 * then:
 *
 * - every direct-path case from Tasks 6–13 (collect-direct-cases.mjs, the same ones each task's suite
 *   runs) gives today's behaviour, byte for byte where it was captured;
 * - recipients already on You collect keep it: their pages take tips, their held money moves once
 *   they add bank details, a dispute on their tip is still held, and the reserve and reconciliation
 *   keep checking. Only new sign-ups stop being put on it.
 *
 * No partner is called: stand-ins answer.
 */

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const GROSS = 1_000_000n;
const NET = 950_000n;
const REASON = 'Agreed with the owner on the call today';

let database;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
});
after(async () => {
  await database?.close();
});

/** Staff turn You collect on or off: a money switch, so asked by one owner and approved by another. */
async function staffSet(on) {
  const asker = await owner(database);
  const approver = await owner(database);
  await database.db.transaction((tx) =>
    ops.setFeatureSwitch(tx, {
      key: 'you_collect',
      on,
      staffUserId: asker.id,
      approvedBy: approver.id,
      reason: REASON,
      now: new Date(),
    }),
  );
  ops.invalidateFeatureSwitches();
  assert.equal(await ops.featureOn(database.db, 'you_collect'), on);
}

/** Fresh demo pages, then the switch turned on and off again by staff. */
async function freshAndSwitchedOff() {
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  await staffSet(true);
  await staffSet(false);
}

describe("switch off means today's behaviour everywhere", () => {
  beforeEach(freshAndSwitchedOff);
  for (const directCase of DIRECT_CASES)
    test(`Task ${directCase.task}: ${directCase.name}`, () =>
      directCase.run({
        database,
        switchOn: false,
        // Off here, always: a case asking for it on would be testing something else.
        setYouCollect: async (on) => {
          assert.equal(on, false, 'the switch-off rerun never turns it on');
          assert.equal(await ops.featureOn(database.db, 'you_collect'), false);
        },
        afterReset: async () => {
          await ops.ensureOwnerRole(database.db);
          await staffSet(true);
          await staffSet(false);
        },
      }));
});

/** A paid collect tip to `profile` (Task 7's booking: held money and one waiting share). */
async function collectTip(profileId, handle, paidAt) {
  const { db } = database;
  const quote = await ops.createQuote(db, {
    handle,
    tipMinor: GROSS,
    currency: 'NGN',
    now: new Date(paidAt.getTime() - 2 * MIN),
  });
  assert.equal(quote.collectionMode, 'collect', 'the page keeps You collect');
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    now: new Date(paidAt.getTime() - 2 * MIN),
  });
  await ops.markAttemptInitiated(db, {
    attemptId: intent.attemptId,
    provider: 'bachs',
    providerReference: `platform:cs_${randomUUID().slice(0, 8)}`,
  });
  await q(`UPDATE payment_attempts SET created_at = $2 WHERE id = $1`, [
    intent.attemptId,
    new Date(paidAt.getTime() - MIN),
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
    now: paidAt,
    minAgeMs: 0,
    attemptId: intent.attemptId,
  });
  assert.equal(result.applied, 1);
  const [share] = await q(
    `SELECT id FROM collect_transfers WHERE tip_id = $1 AND kind = 'share'`,
    [intent.tipId],
  );
  assert.ok(share, `a share for ${profileId}`);
  return { tipId: intent.tipId, shareId: share.id, chargeReference };
}

/** A stand-in for the partner's transfers: each key moves once, and the list shows it by group. */
function transfersPartner() {
  const listed = [];
  return {
    listed,
    provider: {
      name: 'bachs-sandbox',
      async sendCollectTransfer(input) {
        let transfer = listed.find((t) => t.group === input.idempotencyKey);
        if (!transfer) {
          transfer = {
            transferRef: `tr_${listed.length + 1}`,
            status: 'paid',
            amountMinor: input.amountMinor,
            currency: input.currency,
            group: input.idempotencyKey,
            accountRef: input.accountRef,
          };
          listed.push(transfer);
        }
        return { transferRef: transfer.transferRef, status: 'paid' };
      },
      async listAccountTransfers(accountRef) {
        return listed
          .filter((t) => t.accountRef === accountRef)
          .map(({ transferRef, status, amountMinor, currency, group }) => ({
            transferRef,
            status,
            amountMinor,
            currency,
            group,
          }));
      },
      async payoutCapability() {
        return { status: 'active', requirementsDue: [] };
      },
      async listDisputes() {
        return [];
      },
    },
  };
}

test('switching off keeps existing collect recipients tipping and transferring', async () => {
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  const signUp = async (handle) => {
    const userId = await newUser(database.pool);
    await signUpRoute(database.db).claim({ userId }, { handle }, undefined);
    const [row] = await q(
      `UPDATE profiles SET page_state = 'live', created_at = $2 WHERE user_id = $1
       RETURNING id, collection_mode AS mode`,
      [userId, new Date(Date.now() - 30 * DAY)],
    );
    return row;
  };

  // On: a sign-up is put on You collect, is tipped twice, and one tip is disputed.
  await staffSet(true);
  const early = await signUp('earlybird');
  assert.equal(early.mode, 'collect');
  const disputed = await collectTip(
    early.id,
    'earlybird',
    new Date(Date.now() - 2 * DAY),
  );
  const kept = await collectTip(
    early.id,
    'earlybird',
    new Date(Date.now() - DAY),
  );
  const disputeRef = `dp_${randomUUID().slice(0, 10)}`;
  const dispute = (over = {}) => ({
    kind: 'dispute',
    eventId: `evt_${randomUUID()}`,
    eventType: 'dispute.created',
    scope: 'platform',
    partnerDisputeId: disputeRef,
    chargeReference: disputed.chargeReference,
    providerReference: null,
    operationReference: null,
    status: 'open',
    amountMinor: GROSS,
    currency: 'NGN',
    reason: 'fraudulent',
    respondBy: new Date(Date.now() + 7 * DAY),
    feeMinor: null,
    feeCurrency: null,
    occurredAt: new Date(Date.now() - DAY),
    ...over,
  });
  assert.equal(
    (
      await ops.applyDisputeEvent(database.db, {
        event: dispute(),
        provider: 'bachs',
        now: new Date(),
      })
    ).outcome,
    'opened',
  );

  // Off, with money held and a dispute open.
  await staffSet(false);

  // A new sign-up is no longer put on it: undecided, so direct, as today.
  const late = await signUp('latecomer');
  assert.equal(late.mode, null);
  assert.equal(
    (
      await ops.createQuote(database.db, {
        handle: 'latecomer',
        tipMinor: GROSS,
        currency: 'NGN',
      })
    ).collectionMode,
    'direct',
  );

  // The existing collect page still takes tips, and they are still held for them.
  const third = await collectTip(early.id, 'earlybird', new Date());
  assert.equal(await ops.heldTotal(database.db, 'NGN'), 3n * NET);
  const status = await ops.collectStatus(database.db, early.id, new Date());
  assert.equal(status.mode, 'collect');
  assert.equal(status.paused, false);

  // They add bank details (Task 13's result, written as its suite proves it), and the held tips move,
  // except the disputed one, which stays held until the dispute is settled.
  await q(`UPDATE profiles SET collect_verified_at = now() WHERE id = $1`, [
    early.id,
  ]);
  await q(
    `INSERT INTO payment_accounts (id, profile_id, provider, environment, provider_account_reference, status)
     VALUES ($1, $2, 'bachs', 'sandbox', 'acct_earlybird', 'ONBOARDING')`,
    [randomUUID(), early.id],
  );
  await q(
    `INSERT INTO payout_destinations (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
     VALUES ($1, $2, 'bachs', 'dest_earlybird', '058', 'Pretend Guaranty Bank', '1234', 'usable')`,
    [randomUUID(), early.id],
  );
  const partner = transfersPartner();
  const move = async () => {
    const now = new Date();
    await ops.releaseWaitingTransfers(database.db, { now });
    await ops.runCollectTransfers(database.db, {
      provider: partner.provider,
      now,
    });
  };
  await move();
  const statusOf = async (id) =>
    (await q(`SELECT status FROM collect_transfers WHERE id = $1`, [id]))[0]
      .status;
  assert.equal(await statusOf(kept.shareId), 'paid');
  assert.equal(await statusOf(third.shareId), 'paid');
  assert.notEqual(await statusOf(disputed.shareId), 'paid');
  assert.equal(await ops.heldTotal(database.db, 'NGN'), NET);

  // The dispute is won with the switch still off: its share is let go and moves too.
  assert.equal(
    (
      await ops.applyDisputeEvent(database.db, {
        event: dispute({
          eventType: 'dispute.updated',
          status: 'won',
          occurredAt: new Date(),
        }),
        provider: 'bachs',
        now: new Date(),
      })
    ).outcome,
    'won',
  );
  await move();
  assert.equal(await statusOf(disputed.shareId), 'paid');
  assert.equal(await ops.heldTotal(database.db, 'NGN'), 0n);
  assert.deepEqual(
    partner.listed.map((t) => t.group).sort(),
    [disputed, kept, third].map((t) => `tipme-collect-${t.tipId}`).sort(),
    'each share moved once',
  );

  // The reserve check still applies its levels while money was held, and the reconciliation still
  // compares the partner's transfers with ours.
  const tipAgain = await collectTip(early.id, 'earlybird', new Date());
  assert.equal(await ops.heldTotal(database.db, 'NGN'), NET);
  const alerts = [];
  const reading = await ops.checkCollectReserve(database.db, {
    provider: {
      name: 'bachs-sandbox',
      async platformBalances() {
        // ₦4,000 of TipMe's own above what it holds: far below the ₦500,000 warning level.
        return [
          {
            currency: 'NGN',
            availableMinor: NET + 400_000n,
            pendingMinor: 0n,
          },
        ];
      },
      async platformPayoutSchedule() {
        return { NGN: 'manual' };
      },
    },
    alert: async (text, level) => alerts.push(level),
    emailOwners: async () => {},
    now: new Date(),
  });
  const ngn = reading.perCurrency.find((c) => c.currency === 'NGN');
  assert.equal(ngn.heldMinor, NET);
  assert.equal(ngn.level, 'critical', 'still checked with the switch off');
  assert.ok(alerts.length > 0);
  // The partner lists one transfer we never made: the reconciliation still finds it.
  partner.listed.push({
    transferRef: 'tr_stray',
    status: 'paid',
    amountMinor: 1n,
    currency: 'NGN',
    group: `tipme-collect-${randomUUID()}`,
    accountRef: 'acct_earlybird',
  });
  assert.ok(
    (
      await ops.reconcileCollect(database.db, {
        provider: partner.provider,
        day: new Date(),
      })
    ).mismatches >= 1,
  );
  assert.equal(await statusOf(tipAgain.shareId), 'waiting');
});
