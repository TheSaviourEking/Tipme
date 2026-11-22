import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { CollectBankController } from '../../apps/api/dist/profiles/collect-bank.controller.js';
import * as ops from '../../packages/database/dist/index.js';
import {
  openTestDatabase,
  queuedMail,
} from '../../packages/database/dist/test-support.js';
import { newUser, signUpRoute } from './collect-checkout-support.mjs';
import { owner, seriousRefund } from './collect-direct-cases.mjs';
import { setSwitch } from './helpers.mjs';

/*
 * You collect, end to end (plan Task 16, spec §2.1, §3–§6, §12): one new recipient's whole journey
 * with the switch turned on by staff, against a pretend partner. Sign up → tip → held → reminder on
 * day 7 → add bank details → transfer paid → withdraw within the first cap → refund of a later tip,
 * taken back → dispute lost with partial recovery.
 *
 * After every step the books are checked two ways: the ledger balances in every currency (each
 * transaction and in total), and Σ held_for_recipients equals what the pretend partner's platform
 * balance holds for recipients. The pretend partner keeps that second figure from the money it
 * actually moves, never from TipMe's books: a tip's net arrives for its recipient (the quote says
 * how much is theirs), a transfer to their account takes it out, a transfer back puts it in, a refund
 * pays it out, and a lost dispute spends what was taken back for it first and TipMe's own money for
 * the rest. Its whole balance is also read by the reserve check, which must say "ok" throughout.
 *
 * No partner is called (test money only, and none of that): the stand-in answers.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GROSS = 1_000_000n; // ₦10,000 on Free: TipMe keeps 5%.
const PARTNER_FEE = 20_000n; // What the partner keeps of a ₦10,000 card payment.
const OWN_START = 100_000_000n; // ₦1,000,000 of TipMe's own, above the ₦500,000 warning level.
const OWN_START_USD = 10_000n; // $100, so a $15 dispute fee leaves it above zero.
const WITHDRAW = 650_000n; // ₦6,500 of the first tip's ₦9,500.
const SECRET = 'test-auth-code-secret-at-least-32-chars!';
const sealing = ops.mailSealing(Buffer.alloc(32, 7));
const REASON = 'Agreed with the owner on the call today';
// Real "now" is 8 days after sign-up, so the reminder on day 7 is in the past and the routes that
// stamp the real clock (bank details, withdrawals, staff actions) come after it.
const T0 = new Date(Math.floor(Date.now() / MIN) * MIN - 8 * DAY);
const at = (ms) => new Date(T0.getTime() + ms);
// Built at run time, so no account-number-like literal sits in the source.
const ACCOUNT_NUMBER = `${'7'.repeat(8)}42`;
const LEGAL_NAME = { first: 'Nneka', last: 'Eze' };

let database;
const q = (text, values = []) =>
  database.pool.query(text, values).then((result) => result.rows);

before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await ops.seedDemoProfiles(database.db);
  await ops.ensureOwnerRole(database.db);
  ops.registerRealSeriousActions();
  await setSwitch(database.pool, 'tip_refunds', true);
});
after(async () => {
  await setSwitch(database.pool, 'you_collect', false);
  await database?.close();
});

/**
 * The pretend partner: TipMe's own platform balance per currency, split into what it holds for
 * recipients and TipMe's own, each recipient account's balance, and every transfer it made.
 */
function pretendPartner() {
  const forRecipients = new Map([['NGN', 0n]]);
  const own = new Map([
    ['NGN', OWN_START],
    ['USD', OWN_START_USD],
  ]);
  const accounts = new Map();
  const transfers = [];
  const refunds = [];
  const backs = new Map();
  const calls = [];
  let n = 0;
  const add = (map, currency, amount) =>
    map.set(currency, (map.get(currency) ?? 0n) + amount);
  const moved = (input, accountRef) => {
    let transfer = transfers.find((t) => t.group === input.idempotencyKey);
    if (!transfer) {
      transfer = {
        transferRef: `tr_${transfers.length + 1}`,
        status: 'paid',
        amountMinor: input.amountMinor,
        currency: input.currency,
        group: input.idempotencyKey,
        accountRef,
      };
      transfers.push(transfer);
      return { transfer, fresh: true };
    }
    return { transfer, fresh: false };
  };
  const account = (reference) => ({
    accountReference: reference,
    active: false,
    ngnCardCollectionStatus: null,
    bankTransferStatus: null,
    feeCollector: 'platform',
    requirementsDue: [],
    holdsLocalCurrency: accounts.get(reference)?.ngn ?? false,
  });
  const provider = {
    name: 'bachs-sandbox',
    environment: 'sandbox',
    capabilities: { connectedAccounts: true },
    // Adding bank details (Task 13).
    async listBanks() {
      return [{ code: '058', name: 'Pretend Guaranty Bank' }];
    },
    async resolveBankAccount() {
      calls.push('resolve');
      return { accountName: 'NNEKA EZE' };
    },
    async createReceiveOnlyPersonAccount(input) {
      calls.push('create');
      n += 1;
      const reference = `acct_person_${n}`;
      accounts.set(reference, {
        name: input.legalName,
        ngn: false,
        balance: 0n,
      });
      await input.onCreated?.(reference);
      return account(reference);
    },
    async nameReceiveOnlyPerson(input) {
      calls.push('name');
      accounts.get(input.accountReference).name = input.legalName;
      return account(input.accountReference);
    },
    async holdLocalCurrency(reference) {
      accounts.get(reference).ngn = true;
      return account(reference);
    },
    async getRecipientAccount(reference) {
      return account(reference);
    },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
    async requestPayoutCapabilities() {},
    async setManualPayouts() {},
    async addPayoutDestination(reference, input) {
      calls.push('add');
      return {
        destinationRef: `dest_${reference}_${input.bankCode}`,
        usable: true,
        status: 'usable',
      };
    },
    async payoutDestinationStatus() {
      return 'usable';
    },
    // The transfer machine (Tasks 8–10): TipMe's balance to a recipient's account, and back.
    async sendCollectTransfer(input) {
      const { transfer, fresh } = moved(input, input.accountRef);
      if (fresh) {
        add(forRecipients, input.currency, -input.amountMinor);
        accounts.get(input.accountRef).balance += input.amountMinor;
      }
      return { transferRef: transfer.transferRef, status: 'paid' };
    },
    async collectBack(input) {
      const { transfer, fresh } = moved(input, input.accountRef);
      if (fresh) {
        const held = accounts.get(input.accountRef);
        assert.ok(held.balance >= input.amountMinor, 'only what is there');
        held.balance -= input.amountMinor;
        add(forRecipients, input.currency, input.amountMinor);
        backs.set(input.idempotencyKey, input.amountMinor);
      }
      return { transferRef: transfer.transferRef, status: 'paid' };
    },
    async listAccountTransfers(accountRef) {
      return transfers
        .filter((t) => t.accountRef === accountRef)
        .map(({ transferRef, status, amountMinor, currency, group }) => ({
          transferRef,
          status,
          amountMinor,
          currency,
          group,
        }));
    },
    // A withdrawal (today's payout code) reads the recipient's own account.
    async payoutBalance(accountRef) {
      return { availableMinor: accounts.get(accountRef)?.balance ?? 0n };
    },
    async quotePayoutFee() {
      return { feeMinor: 5000n, exact: false };
    },
    async initiatePayout() {
      throw new Error('a request never starts a payout');
    },
    async coverPayoutFee() {
      throw new Error('a request never moves the fee');
    },
    // Refunds out of TipMe's own balance (Task 10).
    async refundPlatformCharge(input) {
      refunds.push({ ...input });
      return {
        refundReference: `rf_${refunds.length}`,
        status: 'processing',
      };
    },
    async verifyTransaction() {
      return {
        status: 'succeeded',
        amountMinor: GROSS,
        currency: 'NGN',
        feeMinor: PARTNER_FEE,
        feePaidBy: 'platform',
        method: 'NGN_CARD',
      };
    },
    // The reserve check (Task 11) and reconciliation.
    async platformBalances() {
      return [...own.keys()].map((currency) => ({
        currency,
        availableMinor:
          (own.get(currency) ?? 0n) + (forRecipients.get(currency) ?? 0n),
        pendingMinor: 0n,
      }));
    },
    async platformPayoutSchedule() {
      return { NGN: 'manual' };
    },
    async listDisputes() {
      return [];
    },
  };
  return {
    provider,
    forRecipients,
    own,
    accounts,
    refunds,
    calls,
    /** A collect tip paid on TipMe's own checkout: its net is the recipient's, the rest TipMe's. */
    paid(quote) {
      const net = quote.breakdown.recipientNetMinor;
      add(forRecipients, quote.currency, net);
      add(own, quote.currency, GROSS - net - PARTNER_FEE);
    },
    /** A refund the partner paid: the supporter gets the recipient's part (tip minus TipMe's fee). */
    refunded(amountMinor) {
      add(forRecipients, 'NGN', -amountMinor);
    },
    /** A dispute fee taken from TipMe's own money. */
    disputeFee(amountMinor, currency) {
      add(own, currency, -amountMinor);
    },
    /** A lost dispute takes the payment: first what came back for it, then TipMe's own money. */
    disputeLost(amountMinor, backKey) {
      const recovered = backs.get(backKey) ?? 0n;
      add(forRecipients, 'NGN', -recovered);
      add(own, 'NGN', -(amountMinor - recovered));
    },
  };
}

const partner = pretendPartner();

/** The ledger balances in every currency, per transaction and in total. */
async function assertBalanced(step) {
  assert.deepEqual(
    await q(
      `SELECT transaction_id, currency FROM ledger_entries
        GROUP BY transaction_id, currency
       HAVING SUM(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END) <> 0`,
    ),
    [],
    `${step}: every transaction balances in its currency`,
  );
  for (const { currency, net } of await q(
    `SELECT currency, SUM(CASE WHEN side = 'debit' THEN amount_minor ELSE -amount_minor END)::text AS net
       FROM ledger_entries GROUP BY currency`,
  ))
    assert.equal(net, '0', `${step}: the ledger balances in ${currency}`);
}

/** The two book checks, after every step, plus the reserve check reading the partner's balance. */
async function assertBooks(step, now = new Date()) {
  await assertBalanced(step);
  for (const currency of ['NGN', 'USD'])
    assert.equal(
      await ops.heldTotal(database.db, currency),
      partner.forRecipients.get(currency) ?? 0n,
      `${step}: Σ held = what the partner holds for recipients (${currency})`,
    );
  const alerts = [];
  const result = await ops.checkCollectReserve(database.db, {
    provider: partner.provider,
    alert: async (text, level) => alerts.push({ text, level }),
    emailOwners: async () => {},
    now,
  });
  const ngn = result.perCurrency.find((c) => c.currency === 'NGN');
  assert.equal(ngn.level, 'ok', `${step}: reserve`);
  assert.equal(ngn.heldMinor, partner.forRecipients.get('NGN'), step);
  assert.equal(ngn.ownMinor, partner.own.get('NGN'), step);
  assert.deepEqual(alerts, [], `${step}: no alert`);
}

const controller = new CollectBankController(
  {
    PAYMENT_PROVIDER: 'bachs-sandbox',
    WEB_ORIGIN: 'http://127.0.0.1:3000',
    AUTH_CODE_SECRET: SECRET,
  },
  {
    get db() {
      return database.db;
    },
  },
  partner.provider,
  { info() {}, warn() {}, error() {} },
  sealing,
  { async invalidate() {} },
);

/** A collect tip quoted at `quotedAt` and paid on TipMe's own checkout at `paidAt`. */
async function collectTip(handle, quotedAt, paidAt) {
  const { db } = database;
  const quote = await ops.createQuote(db, {
    handle,
    tipMinor: GROSS,
    currency: 'NGN',
    now: quotedAt,
  });
  assert.equal(quote.collectionMode, 'collect');
  const intent = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
    now: quotedAt,
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
          feeMinor: PARTNER_FEE,
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
  partner.paid(quote);
  const [share] = await q(
    `SELECT id FROM collect_transfers WHERE tip_id = $1 AND kind = 'share'`,
    [intent.tipId],
  );
  return { tipId: intent.tipId, shareId: share.id, chargeReference, quote };
}

const shareStatus = async (id) =>
  (await q(`SELECT status FROM collect_transfers WHERE id = $1`, [id]))[0]
    .status;
const moveShares = async (now = new Date()) => {
  await ops.releaseWaitingTransfers(database.db, { now });
  await ops.runCollectTransfers(database.db, {
    provider: partner.provider,
    now,
  });
};

test('sign up → tip → held → reminder day 7 → add bank details → transfer paid → withdraw within the first cap → refund of a later tip taken back → dispute lost with partial recovery', async () => {
  // Staff turn You collect on, with a second person (a money switch).
  const asker = await owner(database);
  const approver = await owner(database);
  await database.db.transaction((tx) =>
    ops.setFeatureSwitch(tx, {
      key: 'you_collect',
      on: true,
      staffUserId: asker.id,
      approvedBy: approver.id,
      reason: REASON,
      now: new Date(),
    }),
  );
  ops.invalidateFeatureSwitches();
  assert.equal(await ops.featureOn(database.db, 'you_collect'), true);
  await assertBooks('switched on', at(0));

  // 1. Sign up: a new page is on You collect at once, with no partner account.
  const userId = await newUser(database.pool);
  await q(
    `UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1`,
    [userId, `nneka.${randomUUID().slice(0, 6)}@example.test`],
  );
  await signUpRoute(database.db).claim(
    { userId },
    { handle: 'nneka' },
    undefined,
  );
  const [page] = await q(
    `UPDATE profiles SET page_state = 'live', created_at = $2 WHERE user_id = $1
     RETURNING id, collection_mode`,
    [userId, at(0)],
  );
  assert.equal(page.collection_mode, 'collect');
  assert.deepEqual(
    await q(`SELECT id FROM payment_accounts WHERE profile_id = $1`, [page.id]),
    [],
  );
  await assertBooks('sign up', at(0));

  // 2. A tip, taken before any bank details: ₦9,500 of it is theirs, held by TipMe.
  const first = await collectTip('nneka', at(HOUR - 5 * MIN), at(HOUR));
  const net = first.quote.breakdown.recipientNetMinor;
  assert.equal(net, 950_000n);
  await assertBooks('tip', at(HOUR));

  // 3. Held: kept for them, not withdrawable, the share waiting for bank details.
  let status = await ops.collectStatus(database.db, page.id, at(2 * HOUR));
  assert.equal(status.mode, 'collect');
  assert.equal(status.verified, false);
  assert.equal(status.heldMinor, net);
  assert.equal(status.paused, false);
  assert.equal(await shareStatus(first.shareId), 'waiting');
  assert.equal(
    (await ops.balanceOf(database.db, page.id)).availableMinor,
    0n,
    'nothing withdrawable before bank details',
  );
  await assertBooks('held', at(2 * HOUR));

  // 4. Day 7: one reminder, once.
  const day7 = at(7 * DAY + 2 * HOUR);
  assert.equal(
    await ops.sendCollectReminders(database.db, { now: day7, sealing }),
    1,
  );
  assert.equal(
    await ops.sendCollectReminders(database.db, { now: day7, sealing }),
    0,
  );
  assert.deepEqual(
    await q(
      `SELECT kind, body FROM notifications WHERE user_id = $1 AND kind = 'collect_reminder'`,
      [userId],
    ),
    [
      {
        kind: 'collect_reminder',
        body: 'You have ₦9,500 in tips waiting. Add your bank details to withdraw it.',
      },
    ],
  );
  await assertBooks('reminder', day7);

  // 5. Bank details: the name, the bank, the code from their email. Verified at once.
  await q(`DELETE FROM email_codes`);
  assert.equal(
    (
      await ops.requestPayoutDestinationCode(database.db, sealing, {
        userId,
        secret: SECRET,
      })
    ).status,
    'sent',
  );
  const code = (await queuedMail(database.db, sealing, { limit: 50 })).find(
    (mail) => mail.type === 'payout_destination_code' && mail.userId === userId,
  ).data.code;
  const added = await controller.add(
    { userId },
    {
      legalName: LEGAL_NAME,
      bankCode: '058',
      accountNumber: ACCOUNT_NUMBER,
      confirmed: true,
      emailCode: code,
    },
  );
  assert.equal(added.data.state, 'verified', JSON.stringify(added.data));
  const [{ provider_account_reference: accountRef }] = await q(
    `SELECT provider_account_reference FROM payment_accounts WHERE profile_id = $1`,
    [page.id],
  );
  status = await ops.collectStatus(database.db, page.id, new Date());
  assert.equal(status.verified, true);
  // Only the last four digits are kept.
  assert.ok(
    !JSON.stringify(await q(`SELECT * FROM payout_destinations`)).includes(
      ACCOUNT_NUMBER,
    ),
  );
  await assertBooks('bank details');

  // 6. The held share moves to their account, once.
  await moveShares();
  await moveShares();
  assert.equal(await shareStatus(first.shareId), 'paid');
  assert.equal(partner.accounts.get(accountRef).balance, net);
  assert.equal((await ops.balanceOf(database.db, page.id)).availableMinor, net);
  await assertBooks('transfer paid');

  // 7. A first withdrawal, within the first cap (₦50,000).
  status = await ops.collectStatus(database.db, page.id, new Date());
  assert.equal(status.firstWithdrawalCapMinor, 5_000_000n);
  assert.ok(WITHDRAW <= status.firstWithdrawalCapMinor);
  const withdrawal = await ops.requestWithdrawal(database.db, {
    profileId: page.id,
    amountMinor: WITHDRAW,
    idempotencyKey: randomUUID(),
    provider: partner.provider,
    now: new Date(),
  });
  assert.equal(withdrawal.status, 'REQUESTED');
  assert.equal(
    (await ops.balanceOf(database.db, page.id)).availableMinor,
    net - WITHDRAW,
  );
  await assertBooks('withdraw');

  // 8. A later tip, moved to their account, then refunded: taken back first, then refunded.
  const later = await collectTip(
    'nneka',
    new Date(Date.now() - 3 * MIN),
    new Date(Date.now() - 2 * MIN),
  );
  await assertBooks('later tip');
  await moveShares();
  assert.equal(await shareStatus(later.shareId), 'paid');
  await assertBooks('later tip moved');
  const refundId = await seriousRefund(database, later.tipId);
  const [asked] = await q(
    `SELECT collect_plan, amount_minor::text AS amount FROM tip_refunds WHERE id = $1`,
    [refundId],
  );
  assert.deepEqual(asked, { collect_plan: 'take_back', amount: String(net) });
  const sendRefunds = () =>
    ops.sendTipRefunds(database.db, {
      provider: partner.provider,
      providerName: 'bachs',
      now: new Date(),
    });
  // Nothing is refunded until their part is back in TipMe's balance.
  assert.deepEqual(await sendRefunds(), { sent: 0, failed: 0 });
  await moveShares();
  await assertBooks('refund: taken back');
  assert.deepEqual(await sendRefunds(), { sent: 1, failed: 0 });
  assert.equal(partner.refunds.length, 1);
  assert.equal(partner.refunds[0].amountMinor, net);
  assert.equal(
    await ops.applyTipRefundEvent(database.db, {
      tipRefundId: refundId,
      refundState: 'paid',
      partnerReversalId: 'refund.rf_1',
      refundedMinor: net,
      refundFeeMinor: 0n,
      now: new Date(),
    }),
    'refunded',
  );
  partner.refunded(net);
  assert.equal(
    (await ops.balanceOf(database.db, page.id)).availableMinor,
    net - WITHDRAW,
    'the later tip is gone; the first tip less the withdrawal is left',
  );
  await assertBooks('refund paid');

  // 9. A dispute on the first tip, lost. ₦6,500 of it is on its way to their bank, so ₦3,000 is
  //    held, taken back and spent on the loss; TipMe absorbs the other ₦7,000, and the $15 fee.
  const disputeRef = `dp_${randomUUID().slice(0, 10)}`;
  const dispute = (over) => ({
    kind: 'dispute',
    eventId: `evt_${randomUUID()}`,
    eventType: 'dispute.created',
    scope: 'platform',
    partnerDisputeId: disputeRef,
    chargeReference: first.chargeReference,
    providerReference: null,
    operationReference: null,
    status: 'open',
    amountMinor: GROSS,
    currency: 'NGN',
    reason: 'fraudulent',
    respondBy: new Date(Date.now() + 7 * DAY),
    feeMinor: 1500n,
    feeCurrency: 'USD',
    occurredAt: new Date(),
    ...over,
  });
  assert.equal(
    (
      await ops.applyDisputeEvent(database.db, {
        event: dispute({}),
        provider: 'bachs',
        now: new Date(),
      })
    ).outcome,
    'opened',
  );
  partner.disputeFee(1500n, 'USD');
  const [opened] = await q(
    `SELECT id, held_minor::text AS held FROM disputes WHERE partner_dispute_id = $1`,
    [disputeRef],
  );
  assert.equal(opened.held, String(net - WITHDRAW));
  assert.equal((await ops.balanceOf(database.db, page.id)).availableMinor, 0n);
  await assertBooks('dispute opened');

  assert.equal(
    (
      await ops.applyDisputeEvent(database.db, {
        event: dispute({
          eventType: 'dispute.updated',
          status: 'lost',
          occurredAt: new Date(Date.now() + MIN),
        }),
        provider: 'bachs',
        now: new Date(),
      })
    ).outcome,
    'lost',
  );
  assert.equal(
    await ops.settleLostDispute(database.db, {
      disputeId: opened.id,
      now: new Date(),
    }),
    'waiting_back',
  );
  await moveShares();
  assert.equal(
    await ops.settleLostDispute(database.db, {
      disputeId: opened.id,
      now: new Date(),
    }),
    'posted',
  );
  partner.disputeLost(GROSS, `tipme-collect-back-${opened.id}`);
  assert.equal(
    partner.forRecipients.get('NGN'),
    0n,
    'the partner holds nothing for recipients now',
  );
  await assertBooks('dispute lost, partly recovered');
  const [loss] = await q(
    `SELECT e.amount_minor::text AS amount FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.operation_key = $1 AND a.code = 'dispute_loss_expense'`,
    [`dispute_loss.${opened.id}`],
  );
  assert.equal(loss.amount, String(GROSS - (net - WITHDRAW)));
  assert.equal(
    await ops.settleLostDispute(database.db, {
      disputeId: opened.id,
      now: new Date(),
    }),
    'done',
  );

  // The daily reconciliation finds nothing wrong with any of it.
  assert.equal(
    (
      await ops.reconcileCollect(database.db, {
        provider: partner.provider,
        day: new Date(),
      })
    ).mismatches,
    0,
  );
  assert.deepEqual(
    await q(
      `SELECT kind FROM issues WHERE status = 'open' AND kind LIKE 'collect%'`,
    ),
    [],
  );
  // The partner's name never reached the recipient.
  assert.ok(
    !JSON.stringify(
      await q(`SELECT title, body FROM notifications WHERE user_id = $1`, [
        userId,
      ]),
    ).match(/bachs/i),
  );
});
