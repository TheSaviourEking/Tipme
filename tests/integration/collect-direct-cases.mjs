import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { CollectBankController } from '../../apps/api/dist/profiles/collect-bank.controller.js';
import { WebhookService } from '../../apps/api/dist/webhooks/webhook.service.js';
import * as ops from '../../packages/database/dist/index.js';
import { newTotpSecret, totpAt } from '../../packages/domain/dist/index.js';
import {
  recordingProviders,
  services,
  switchOffTranscript,
} from './collect-checkout-support.mjs';
import { MAIL_SEAL_KEY, OPS_TOTP_KEY, setSwitch } from './helpers.mjs';

/*
 * You collect's direct path (plan Task 16, Global Constraints "Switch"): the cases from Tasks 6–13
 * that prove a recipient who is not on You collect gets exactly today's behaviour. Each task's suite
 * registers its own cases from here with the switch as that suite tests it, and
 * you-collect-switch-off.test.mjs imports every one and reruns it with the switch turned off by
 * staff. A case starts on a database already reset and seeded with the demo pages; `setYouCollect`
 * is how the caller sets the switch (the suites write its row, the switch-off file asserts it is off).
 * No partner is called: stand-ins answer, and any call a direct path must not make throws.
 */

const [ADA, TOBI] = ops.DEMO_PROFILES;
const MIN = 60_000;
const sealing = ops.mailSealing(Buffer.alloc(32, 7));

const query =
  (database) =>
  (text, values = []) =>
    database.pool.query(text, values).then((result) => result.rows);

/** A partner method a direct path must never reach. */
const never = (name) => async () => {
  throw new Error(`${name} must not be called on the direct path`);
};

/** Ada's own ACTIVE partner account, as today's direct recipients have (once: a suite may have made it). */
async function adaActive(database) {
  const { db } = database;
  const { rows } = await database.pool.query(
    `SELECT 1 FROM payment_accounts WHERE profile_id = $1 AND status = 'ACTIVE'`,
    [ADA.id],
  );
  if (rows.length > 0) return;
  await ops.beginPaymentAccountCreation(db, {
    profileId: ADA.id,
    provider: 'bachs',
    environment: 'sandbox',
  });
  await ops.updatePaymentAccountStatus(db, {
    profileId: ADA.id,
    provider: 'bachs',
    environment: 'sandbox',
    providerAccountReference: 'acct_ada123',
    status: 'ACTIVE',
    chargesEnabled: true,
    payoutsEnabled: false,
    feeCollector: 'platform',
    requirementsDue: [],
  });
}

// The database package's own pg, so every statement it sends can be seen (Task 12 M4).
const { Client } = createRequire(
  new URL('../../packages/database/package.json', import.meta.url),
)('pg');

/** The SQL text of every statement sent while `work` runs. */
export async function statements(work) {
  const seen = [];
  const original = Client.prototype.query;
  Client.prototype.query = function (config, ...rest) {
    seen.push(typeof config === 'string' ? config : (config?.text ?? ''));
    return original.call(this, config, ...rest);
  };
  try {
    await work();
  } finally {
    Client.prototype.query = original;
  }
  return seen;
}

/**
 * Today's withdrawal helpers (moved here from collect-guards.test.mjs, which binds them too), bound
 * to the suite's database as it is when they run.
 */
export function directHelpers(getDatabase) {
  const q = (text, values) => query(getDatabase())(text, values);

  /** A paid direct tip on the recipient's own partner account (today's flow). */
  async function directTip(profile, tipMinor) {
    const { db } = getDatabase();
    const quote = await ops.createQuote(db, {
      handle: profile.handle,
      tipMinor,
      currency: 'NGN',
    });
    assert.equal(quote.collectionMode, 'direct');
    const intent = await ops.createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const reference = `acct_${profile.handle}:chk_${randomUUID().slice(0, 8)}`;
    await ops.markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'bachs',
      providerReference: reference,
    });
    await ops.recordProviderEvent(db, {
      provider: 'bachs',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: tipMinor,
      currency: 'NGN',
      providerFeeMinor: 3000n,
      signatureVerified: true,
      payload: {},
    });
  }

  /** The recipient's own account with manual payouts and a usable bank: a withdrawal can go. */
  async function payoutRoute(profile) {
    await q(
      `INSERT INTO payment_accounts
         (id, profile_id, provider, environment, provider_account_reference, status,
          charges_enabled, payouts_enabled, fee_collector, manual_payouts_at)
       VALUES ($1, $2, 'bachs', 'sandbox', $3, 'ACTIVE', true, true, 'platform', now())`,
      [randomUUID(), profile.id, `acct_${profile.handle}`],
    );
    await q(
      `INSERT INTO payout_destinations
         (id, profile_id, provider, destination_reference, bank_code, bank_name, account_last4, status)
       VALUES ($1, $2, 'bachs', $3, '058', 'Guaranty Trust Bank', '4321', 'usable')`,
      [randomUUID(), profile.id, `ba_${profile.handle}`],
    );
  }

  /** The partner's side of a withdrawal: plenty in the account, ₦50 fee. Never moves money here. */
  const partner = () => ({
    name: 'bachs-sandbox',
    capabilities: { connectedAccounts: true },
    async payoutCapability() {
      return { status: 'active', requirementsDue: [] };
    },
    async payoutBalance() {
      return { availableMinor: 1_000_000_000n };
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
  });

  /** A withdrawal asked at `at`, recorded at that moment (a request stamps the real clock). */
  async function withdraw(profile, amountMinor, at) {
    const result = await ops.requestWithdrawal(getDatabase().db, {
      profileId: profile.id,
      amountMinor,
      idempotencyKey: randomUUID(),
      provider: partner(),
      now: at,
    });
    await q(`UPDATE payouts SET created_at = $2 WHERE id = $1`, [
      result.payoutId,
      at,
    ]);
    return result;
  }

  return { directTip, payoutRoute, partner, withdraw };
}

/** Today's ledger lines of a direct ₦2,000 tip to Ada, captured from dev before Task 7. */
const paymentLine = (code, owner, side, amount) => ({
  type: 'payment',
  code,
  owner,
  side,
  amount: amount.toString(),
});
const DIRECT_GOLDEN = [
  paymentLine('platform_fee_revenue', 'tipme', 'credit', 7000n),
  paymentLine('provider_clearing', 'tipme', 'debit', 198500n),
  paymentLine('provider_fee_expense', 'tipme', 'debit', 1500n),
  paymentLine('provider_fee_recovered', 'tipme', 'credit', 3000n),
  paymentLine('recipient_payable', 'person', 'credit', 190000n),
];

/** A paid direct ₦2,000 tip to Ada on her own account, through the webhook as today. */
async function directPaidTip(database) {
  const { db } = database;
  await adaActive(database);
  const quote = await ops.createQuote(db, {
    handle: 'ada',
    tipMinor: 200000n,
    currency: 'NGN',
  });
  assert.equal(quote.collectionMode, 'direct');
  const { attemptId, tipId } = await ops.createPaymentIntent(db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const reference = 'acct_ada123:chk_paid';
  await ops.markAttemptInitiated(db, {
    attemptId,
    provider: 'bachs',
    providerReference: reference,
  });
  const expectations = [];
  const outcome = await new WebhookService({ db }, sealing, {
    warn() {},
  }).applyBachs(
    {
      kind: 'payment',
      eventId: `evt_${randomUUID()}`,
      eventType: 'collection.succeeded',
      providerReference: reference,
      operationReference: attemptId,
      accountReference: 'acct_ada123',
      status: 'pending',
      amountMinor: 200000n,
      currency: 'NGN',
      feeMinor: 1500n,
      feePaidBy: 'unknown',
    },
    {
      environment: 'sandbox',
      async verifyTransaction(_reference, expectation) {
        expectations.push(expectation);
        return {
          status: 'succeeded',
          amountMinor: 200000n,
          currency: 'NGN',
          feeMinor: 1500n,
        };
      },
    },
  );
  return { attemptId, tipId, reference, outcome, expectations };
}

const linesOf = (database, tipId) =>
  query(database)(
    `SELECT t.operation_type::text AS type, a.code,
            CASE WHEN a.business_id IS NOT NULL THEN 'business'
                 WHEN a.profile_id IS NOT NULL THEN 'person' ELSE 'tipme' END AS owner,
            e.side::text AS side, e.amount_minor::text AS amount
       FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       JOIN ledger_accounts a ON a.id = e.account_id
      WHERE t.tip_id = $1
      ORDER BY t.operation_type, a.code, owner, e.side`,
    [tipId],
  );

const REFUND_REASON =
  'The supporter paid twice by mistake and asked us to refund one.';

/** An owner with a confirmed authenticator and a fresh staff session, as collect-refunds makes one. */
export async function owner(database) {
  const q = query(database);
  const key = Buffer.from(OPS_TOTP_KEY, 'base64');
  const [{ id }] = await q(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`directcase.${randomUUID().slice(0, 8)}@example.com`],
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
  return { id, secret, grantId };
}

/** Staff refund a tip: one owner asks, another approves (the refund is recorded, not sent). */
export async function seriousRefund(database, tipId) {
  ops.registerRealSeriousActions();
  await ops.ensureOwnerRole(database.db);
  await setSwitch(database.pool, 'tip_refunds', true);
  const services = {
    sealing: ops.mailSealing(Buffer.from(MAIL_SEAL_KEY, 'base64')),
    authCodeSecret: 'test-auth-code-secret-of-enough-length',
  };
  const asker = await owner(database);
  const approver = await owner(database);
  const asked = await ops.requestSeriousAction(database.db, {
    name: 'tip.refund',
    payload: { tipId },
    actorId: asker.id,
    grantId: asker.grantId,
    reason: REFUND_REASON,
    services,
  });
  assert.equal(asked.state, 'pending', JSON.stringify(asked));
  const approved = await ops.approveRequest(database.db, {
    requestId: asked.requestId,
    actorId: approver.id,
    code: totpAt(approver.secret, BigInt(Math.floor(Date.now() / 30_000))),
    key: Buffer.from(OPS_TOTP_KEY, 'base64'),
    services,
  });
  assert.equal(approved.status, 'approved', JSON.stringify(approved));
  const [{ id }] = await query(database)(
    `SELECT id FROM tip_refunds WHERE tip_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [tipId],
  );
  return id;
}

/** Each case: the task whose suite owns it, its name there, and what it runs. */
export const DIRECT_CASES = [
  {
    task: 6,
    name: "switch off: every quote and checkout is today's, byte for byte",
    async run({ database, setYouCollect, afterReset }) {
      const expected = JSON.parse(
        await readFile(
          new URL(
            './collect-checkout-switch-off.fixture.json',
            import.meta.url,
          ),
          'utf8',
        ),
      );
      // The transcript reseeds its own pages (a reset), then the caller sets the switch off again.
      assert.deepEqual(
        await switchOffTranscript(database, {
          afterSeed: async () => {
            await afterReset?.();
            await setYouCollect(false);
          },
        }),
        expected,
      );
    },
  },
  {
    task: 6,
    name: 'a direct checkout still opens after its quote expires, as today',
    async run({ database, setYouCollect, switchOn }) {
      await adaActive(database);
      await setYouCollect(switchOn);
      const providers = recordingProviders();
      const checkout = services(database.db, providers);
      const key = randomUUID();
      const quote = await checkout.bachs.quote({
        handle: 'ada',
        amountMinor: '200000',
        currency: 'NGN',
      });
      await ops.createPaymentIntent(database.db, {
        quoteId: quote.quoteId,
        idempotencyKey: key,
      });
      await database.pool.query(
        `UPDATE tip_quotes SET expires_at = now() - interval '5 minutes' WHERE id = $1`,
        [quote.quoteId],
      );
      const [{ collection_mode: mode }] = await query(database)(
        `SELECT collection_mode FROM tip_quotes WHERE id = $1`,
        [quote.quoteId],
      );
      assert.equal(mode, 'direct');
      const created = await checkout.bachs.createIntent(
        { quoteId: quote.quoteId },
        key,
      );
      assert.ok(created.checkoutUrl);
      assert.deepEqual(
        providers.calls.map(([name]) => name),
        ['bachs.initializePayment'],
      );
    },
  },
  {
    task: 7,
    name: "a direct tip's payment is booked exactly as before",
    async run({ database, setYouCollect, switchOn }) {
      await setYouCollect(switchOn);
      const { tipId, outcome, expectations } = await directPaidTip(database);
      assert.equal(outcome, 'confirmed');
      // Still read back against TipMe's whole quoted share, as before.
      assert.deepEqual(expectations, [{ platformFeeMinor: 10000n }]);
      assert.deepEqual(await linesOf(database, tipId), DIRECT_GOLDEN);
      const q = query(database);
      assert.equal(
        (await q(`SELECT 1 FROM collect_transfers WHERE tip_id = $1`, [tipId]))
          .length,
        0,
      );
      assert.equal(
        (await q(`SELECT 1 FROM share_transfers WHERE tip_id = $1`, [tipId]))
          .length,
        0,
      );
    },
  },
  {
    task: 8,
    name: 'a paid direct tip gives the transfer machine nothing to release or send',
    async run({ database, setYouCollect, switchOn }) {
      await setYouCollect(switchOn);
      const { tipId, outcome } = await directPaidTip(database);
      assert.equal(outcome, 'confirmed');
      const now = new Date();
      await ops.releaseWaitingTransfers(database.db, { now });
      // Every partner call throws: a direct tip's money is already in the recipient's account.
      await ops.runCollectTransfers(database.db, {
        provider: {
          name: 'bachs-sandbox',
          sendCollectTransfer: never('sendCollectTransfer'),
          collectBack: never('collectBack'),
          listAccountTransfers: never('listAccountTransfers'),
          payoutCapability: never('payoutCapability'),
        },
        now,
      });
      const q = query(database);
      assert.deepEqual(await q(`SELECT id FROM collect_transfers`), []);
      assert.equal(await ops.heldTotal(database.db, 'NGN'), 0n);
      assert.deepEqual(
        (
          await q(
            `SELECT DISTINCT a.code FROM ledger_entries e
               JOIN ledger_transactions t ON t.id = e.transaction_id
               JOIN ledger_accounts a ON a.id = e.account_id
              WHERE t.tip_id = $1 AND a.code = 'held_for_recipients'`,
            [tipId],
          )
        ).length,
        0,
      );
    },
  },
  {
    task: 9,
    name: "a dispute on a direct tip's own account still opens today's money issue and books nothing",
    async run({ database, setYouCollect, switchOn }) {
      await setYouCollect(switchOn);
      const { attemptId, reference, outcome } = await directPaidTip(database);
      assert.equal(outcome, 'confirmed');
      const q = query(database);
      const entries = async () =>
        (await q(`SELECT count(*)::int AS n FROM ledger_entries`))[0].n;
      const before = await entries();
      const webhooks = new WebhookService({ db: database.db });
      // A recipient's account reports it, so it is today's reversal shape (R1), not a modelled one.
      const dispute = {
        kind: 'reversal',
        eventId: `evt_${randomUUID()}`,
        eventType: 'dispute.created',
        accountReference: 'acct_ada123',
        providerReference: reference,
        operationReference: attemptId,
      };
      assert.equal(
        await webhooks.applyBachs(dispute, { environment: 'sandbox' }),
        'reversal_flagged',
      );
      assert.equal(await entries(), before);
      assert.deepEqual(await q(`SELECT id FROM disputes`), []);
      assert.deepEqual(
        await q(
          `SELECT kind, severity FROM issues WHERE kind = 'payment_reversed'`,
        ),
        [{ kind: 'payment_reversed', severity: 'money' }],
      );
    },
  },
  {
    task: 10,
    name: "a direct tip's refund is unchanged",
    async run({ database, setYouCollect, switchOn }) {
      await setYouCollect(switchOn);
      const q = query(database);
      // The direct path is unchanged (tip-refund.test.mjs): no collect plan, refundAccountCharge.
      await q(`UPDATE profiles SET collection_mode = 'direct' WHERE id = $1`, [
        TOBI.id,
      ]);
      const quote = await ops.createQuote(database.db, {
        handle: 'tobi',
        tipMinor: 1_000_000n,
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
        amountMinor: 1_000_000n,
        currency: 'NGN',
        providerFeeMinor: 20000n,
        signatureVerified: true,
        payload: {},
      });
      assert.equal(
        (await ops.tipRefundFacts(database.db, intent.tipId)).collect,
        null,
      );
      // Asked by one owner and approved by another, as staff refund a tip (tip.refund).
      const refundId = await seriousRefund(database, intent.tipId);
      const [refund] = await q(
        `SELECT collect_plan FROM tip_refunds WHERE id = $1`,
        [refundId],
      );
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
    },
  },
  {
    task: 11,
    name: 'P10: with nothing held, ownMoneyAllows changes nothing and the levels are not applied',
    async run({ database, setYouCollect, switchOn }) {
      await setYouCollect(switchOn);
      // No reading at all, nothing held: every move goes ahead exactly as before You collect.
      assert.equal(await ops.heldTotal(database.db, 'NGN'), 0n);
      for (const voluntary of [true, false])
        assert.equal(
          await ops.ownMoneyAllows(database.db, {
            amountMinor: 10_000_000_000n,
            currency: 'NGN',
            voluntary,
          }),
          true,
        );
      // With the switch off and nothing held, a small balance is not a You collect warning.
      await setYouCollect(false);
      const alerts = [];
      const emails = [];
      const result = await ops.checkCollectReserve(database.db, {
        provider: {
          name: 'bachs-sandbox',
          async platformBalances() {
            return [
              { currency: 'NGN', availableMinor: 1_000n, pendingMinor: 0n },
            ];
          },
          async platformPayoutSchedule() {
            return { NGN: 'manual' };
          },
        },
        alert: async (text, level) => alerts.push({ text, level }),
        emailOwners: async (text) => emails.push(text),
        now: new Date(),
      });
      assert.equal(
        result.perCurrency.find((c) => c.currency === 'NGN').level,
        'ok',
      );
      assert.deepEqual(alerts, []);
      assert.deepEqual(emails, []);
    },
  },
  {
    task: 12,
    name: 'a direct tip’s checkout still opens after its quote expires, as today',
    async run({ database, setYouCollect, switchOn }) {
      await setYouCollect(switchOn);
      const NOW = new Date(Math.floor(Date.now() / MIN) * MIN);
      const quoteAt = (now) =>
        ops.createQuote(database.db, {
          handle: ADA.handle,
          tipMinor: 1_000_000n,
          currency: 'NGN',
          now,
        });
      const intentFor = (quote) =>
        ops.createPaymentIntent(database.db, {
          quoteId: quote.quoteId,
          idempotencyKey: randomUUID(),
          now: NOW,
        });
      const quote = await quoteAt(NOW);
      assert.equal(quote.collectionMode, 'direct');
      const intent = await intentFor(quote);
      const claim = await ops.claimAttemptStart(database.db, {
        attemptId: intent.attemptId,
        provider: 'bachs',
        now: new Date(NOW.getTime() + 20 * MIN),
      });
      assert.equal(claim.outcome, 'claimed');
      const other = await intentFor(await quoteAt(NOW));
      assert.equal(
        await ops.markAttemptInitiated(database.db, {
          attemptId: other.attemptId,
          provider: 'mock',
          providerReference: `mock_${randomUUID().slice(0, 8)}`,
          opensCheckout: true,
          now: new Date(NOW.getTime() + 20 * MIN),
        }),
        'initiated',
      );
    },
  },
  {
    task: 12,
    name: 'a direct recipient’s withdrawals and page are unchanged',
    async run({ database, setYouCollect, switchOn }) {
      await setYouCollect(switchOn);
      const NOW = new Date(Math.floor(Date.now() / MIN) * MIN);
      const DAY = 24 * 60 * MIN;
      // Signed up a week ago: inside the new-account window a collect recipient would have.
      await query(database)(`UPDATE profiles SET created_at = $1`, [
        new Date(NOW.getTime() - 7 * DAY),
      ]);
      const { directTip, payoutRoute, partner, withdraw } = directHelpers(
        () => database,
      );
      for (let i = 0; i < 4; i += 1) await directTip(TOBI, 10_000_000n);
      await payoutRoute(TOBI);
      const status = await ops.collectStatus(database.db, TOBI.id, NOW);
      assert.deepEqual(
        {
          mode: status.mode,
          paused: status.paused,
          heldMinor: status.heldMinor,
          onItsWayMinor: status.onItsWayMinor,
          firstWithdrawalCapMinor: status.firstWithdrawalCapMinor,
          dailyLimitMinor: status.dailyLimitMinor,
        },
        {
          mode: 'direct',
          paused: false,
          heldMinor: 0n,
          onItsWayMinor: 0n,
          firstWithdrawalCapMinor: null,
          dailyLimitMinor: null,
        },
      );
      const quote = await ops.withdrawalQuote(database.db, {
        profileId: TOBI.id,
        providers: { active: partner(), withdrawOnly: [] },
        now: NOW,
      });
      assert.equal(quote.withdrawableMinor, 38_000_000n);
      // A first withdrawal above ₦50,000 and ₦300,000 in a day: as today, and (M4) without a single
      // read of You collect's settings or transfers on the way.
      const seen = await statements(async () => {
        await ops.withdrawalQuote(database.db, {
          profileId: TOBI.id,
          providers: { active: partner(), withdrawOnly: [] },
          now: NOW,
        });
        assert.equal(
          (await withdraw(TOBI, 15_000_000n, NOW)).status,
          'REQUESTED',
        );
      });
      assert.ok(seen.length > 0);
      assert.deepEqual(
        seen.filter((text) => /collect_settings|collect_transfers/.test(text)),
        [],
      );
      assert.equal(
        (await withdraw(TOBI, 15_000_000n, NOW)).status,
        'REQUESTED',
      );
      const balance = await ops.balanceOf(database.db, TOBI.id);
      assert.deepEqual(balance, {
        availableMinor: 8_000_000n,
        confirmingMinor: 0n,
        keptMinor: 0n,
        onItsWayMinor: 0n,
        refundHeldMinor: 0n,
      });
      // The page takes tips however long ago and however much: nothing is held.
      assert.equal(
        (
          await ops.createQuote(database.db, {
            handle: TOBI.handle,
            tipMinor: 1_000_000n,
            currency: 'NGN',
            now: new Date(NOW.getTime() + 60 * DAY),
          })
        ).collectionMode,
        'direct',
      );
      // The reminder sweep never writes to them.
      assert.equal(
        await ops.sendCollectReminders(database.db, {
          now: new Date(NOW.getTime() + 7 * DAY),
          sealing,
        }),
        0,
      );
    },
  },
  {
    task: 13,
    name: 'a direct recipient, or an undecided one with the switch off, has no You collect bank routes (404) and nothing is asked of the partner',
    async run({ database, setYouCollect, switchOn }) {
      const q = query(database);
      const calls = [];
      // Every partner call is recorded and refused: a 404 must come before any of them.
      const provider = new Proxy(
        { name: 'bachs-sandbox', environment: 'sandbox' },
        {
          get(target, key) {
            if (key in target || typeof key !== 'string') return target[key];
            if (key === 'then') return undefined;
            return async () => {
              calls.push(key);
              throw new Error(`${key} must not be called`);
            };
          },
        },
      );
      const controller = new CollectBankController(
        {
          PAYMENT_PROVIDER: 'bachs-sandbox',
          WEB_ORIGIN: 'http://127.0.0.1:3000',
          AUTH_CODE_SECRET: 'test-auth-code-secret-at-least-32-chars!',
        },
        { db: database.db },
        provider,
        { info() {}, warn() {}, error() {} },
        sealing,
        { async invalidate() {} },
      );
      const refused = async (call) => {
        try {
          await call();
        } catch (error) {
          return {
            status: error.getStatus?.(),
            code: error.getResponse?.()?.code ?? error.code,
          };
        }
        return 'allowed';
      };
      // Built at run time, so no account-number-like literal sits in the source.
      const accountNumber = `${'7'.repeat(8)}01`;
      const body = {
        legalName: { first: 'Ada', last: 'Okafor' },
        bankCode: '058',
        accountNumber,
      };
      const setUps = [
        [
          'direct',
          async () => {
            await setYouCollect(switchOn);
            await q(
              `UPDATE profiles SET collection_mode = 'direct' WHERE id = $1`,
              [ADA.id],
            );
          },
        ],
        [
          'undecided, switch off',
          async () => {
            await q(
              `UPDATE profiles SET collection_mode = NULL WHERE id = $1`,
              [ADA.id],
            );
            await setYouCollect(false);
          },
        ],
      ];
      for (const [who, setUp] of setUps) {
        await setUp();
        for (const call of [
          () => controller.status({ userId: ADA.userId }),
          () => controller.lookup({ userId: ADA.userId }, body),
          () =>
            controller.add(
              { userId: ADA.userId },
              { ...body, confirmed: true, emailCode: '123456' },
            ),
        ])
          assert.deepEqual(
            await refused(call),
            { status: 404, code: 'NOT_FOUND' },
            who,
          );
      }
      assert.deepEqual(calls, []);
      // Nothing was written for her either: she is still undecided, with no bank or partner account.
      assert.deepEqual(
        await q(`SELECT collection_mode FROM profiles WHERE id = $1`, [ADA.id]),
        [{ collection_mode: null }],
      );
      assert.deepEqual(
        await q(`SELECT id FROM payout_destinations WHERE profile_id = $1`, [
          ADA.id,
        ]),
        [],
      );
    },
  },
];

/** The cases a task's own suite registers. */
export const casesOf = (task) => DIRECT_CASES.filter((c) => c.task === task);
