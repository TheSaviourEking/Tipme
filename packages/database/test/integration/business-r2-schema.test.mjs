import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SHARE_OPTIONS_BPS as CONTRACT_OPTIONS } from '@tipme/contracts';
import { SHARE_OPTIONS_BPS as DOMAIN_OPTIONS } from '@tipme/domain';
import {
  createPaymentIntent,
  createQuote,
  DEMO_PROFILES,
} from '../../dist/index.js';
import {
  seedAgreement,
  seedBusiness,
  seedMember,
  seedTableCard,
} from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// Business release 2, PR R2-0 Task 27: what the database itself refuses, so no later lane can
// write a share, a team split, a table assignment or a reversal wrongly.

const ADA_USER = DEMO_PROFILES[0].userId;
const DAY_MS = 86_400_000;
const refused = (promise, name) =>
  assert.rejects(promise, (error) => {
    assert.match(String(error.constraint ?? error.message), name);
    return true;
  });

test('the share options agree in contracts and domain', () => {
  assert.deepEqual([...CONTRACT_OPTIONS], [...DOMAIN_OPTIONS]);
});

test('business release 2 schema', async (t) => {
  const database = await useDatabase(t);
  const q = (text, values) =>
    database.pool.query(text, values).then((result) => result.rows);
  const tipAt = async (businessMemberId) =>
    createPaymentIntent(database.db, {
      quoteId: (
        await createQuote(database.db, {
          handle: 'ada',
          tipMinor: 200000n,
          currency: 'NGN',
        })
      ).quoteId,
      idempotencyKey: randomUUID(),
      ...(businessMemberId ? { businessMemberId } : {}),
    });
  const share = (values) =>
    q(
      `INSERT INTO tip_business_shares (tip_id, agreement_id, business_id, business_bps, share_minor)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        values.tipId,
        values.agreementId,
        values.businessId,
        values.bps ?? 1000,
        values.shareMinor ?? 18000,
      ],
    );
  const agreement = (memberId, values = {}) => {
    const proposedAt = values.proposedAt ?? new Date();
    return q(
      `INSERT INTO share_agreements (id, member_id, business_bps, proposed_by, proposed_by_user,
         proposed_at, effective_from, accepted_at)
       VALUES ($1, $2, $3, 'business', $4, $5, $6, $7)`,
      [
        randomUUID(),
        memberId,
        values.bps ?? 1000,
        ADA_USER,
        proposedAt,
        values.effectiveFrom ?? new Date(proposedAt.getTime() + 14 * DAY_MS),
        values.acceptedAt ?? null,
      ],
    );
  };
  // Ada works at a verified business; her tips there carry her membership.
  const setUp = async () => {
    await database.fresh();
    const { businessId, locations } = await seedBusiness(database);
    const { memberId } = await seedMember(database, {
      locationId: locations[0].id,
      profileId: ADA,
    });
    return { businessId, locationId: locations[0].id, memberId };
  };

  await t.test(
    'the database refuses a share row for a tip without a member, or for another member',
    async () => {
      const { businessId, locationId, memberId } = await setUp();
      const { agreementId } = await seedAgreement(database, { memberId });
      // Through Ada's own page: no member, so never a share, even with her agreement in force.
      const ownPage = await tipAt();
      await refused(
        share({ tipId: ownPage.tipId, agreementId, businessId }),
        /tip_business_shares_member/,
      );
      // Tobi's agreement at the same location can't be put on Ada's tip.
      const tobi = await seedMember(database, { locationId, profileId: TOBI });
      const other = await seedAgreement(database, { memberId: tobi.memberId });
      const atBusiness = await tipAt(memberId);
      await refused(
        share({
          tipId: atBusiness.tipId,
          agreementId: other.agreementId,
          businessId,
        }),
        /tip_business_shares_member/,
      );
      // Another business can't be named, and the amount must be the agreed share, rounded down.
      const elsewhere = await seedBusiness(database);
      await refused(
        share({
          tipId: atBusiness.tipId,
          agreementId,
          businessId: elsewhere.businessId,
        }),
        /tip_business_shares_business/,
      );
      await refused(
        share({
          tipId: atBusiness.tipId,
          agreementId,
          businessId,
          shareMinor: 18001,
        }),
        /tip_business_shares_amount/,
      );
      await refused(
        share({
          tipId: atBusiness.tipId,
          agreementId,
          businessId,
          bps: 2000,
          shareMinor: 36000,
        }),
        /tip_business_shares_amount/,
      );
      // 10% of the ₦1,800 net, exactly: accepted once, and then never changed or removed.
      await share({ tipId: atBusiness.tipId, agreementId, businessId });
      await refused(
        q(`UPDATE tip_business_shares SET share_minor = 1 WHERE tip_id = $1`, [
          atBusiness.tipId,
        ]),
        /append-only/,
      );
      await refused(
        q(`DELETE FROM tip_business_shares WHERE tip_id = $1`, [
          atBusiness.tipId,
        ]),
        /append-only/,
      );
    },
  );

  await t.test(
    'a share needs the agreement accepted and in force when the tip was made',
    async () => {
      const { businessId, memberId } = await setUp();
      const later = await seedAgreement(database, {
        memberId,
        startedDaysAgo: -3,
      });
      const tip = await tipAt(memberId);
      await refused(
        share({ tipId: tip.tipId, agreementId: later.agreementId, businessId }),
        /tip_business_shares_in_force/,
      );
      await q(`DELETE FROM share_agreements WHERE id = $1`, [
        later.agreementId,
      ]);
      const open = await seedAgreement(database, { memberId, accepted: false });
      await refused(
        share({ tipId: tip.tipId, agreementId: open.agreementId, businessId }),
        /tip_business_shares_in_force/,
      );
      // A 0% agreement in force is "no share": no row can say so.
      await q(`DELETE FROM share_agreements WHERE id = $1`, [open.agreementId]);
      const none = await seedAgreement(database, { memberId, businessBps: 0 });
      const tipUnderNone = await tipAt(memberId);
      await refused(
        share({
          tipId: tipUnderNone.tipId,
          agreementId: none.agreementId,
          businessId,
          bps: 0,
          shareMinor: 0,
        }),
        /tip_business_shares_(bps|positive)/,
      );
    },
  );

  await t.test(
    'the database refuses business_bps 6000, two agreements in force, and effective_from under 14 days',
    async () => {
      const { memberId } = await setUp();
      for (const bps of [6000, 10000, 500, 4000, -1000])
        await refused(agreement(memberId, { bps }), /share_agreements_bps/);
      for (const bps of [0, 1000, 2000, 3000, 5000]) {
        await agreement(memberId, { bps, acceptedAt: new Date() });
        await q(
          `UPDATE share_agreements SET ended_at = now() WHERE member_id = $1`,
          [memberId],
        );
      }
      const now = new Date();
      await refused(
        agreement(memberId, {
          proposedAt: now,
          effectiveFrom: new Date(now.getTime() + 13 * DAY_MS),
        }),
        /share_agreements_notice/,
      );
      await agreement(memberId, { acceptedAt: now });
      await refused(
        agreement(memberId, { acceptedAt: now }),
        /share_agreements_in_force/,
      );
      await agreement(memberId);
      await refused(agreement(memberId), /share_agreements_open/);
      await refused(
        q(
          `UPDATE share_agreements SET accepted_at = now(), declined_at = now()
            WHERE member_id = $1 AND accepted_at IS NULL`,
          [memberId],
        ),
        /share_agreements_answer|share_agreements_in_force/,
      );
    },
  );

  // A team quote, intent and tip, as R2-D will write them: the location instead of a person.
  const teamTip = async (locationId, netMinor = 180000n) => {
    const quoteId = randomUUID();
    const intentId = randomUUID();
    const tipId = randomUUID();
    const gross = netMinor + 20000n;
    await q(
      `INSERT INTO tip_quotes (id, team_location_id, currency, tip_minor, platform_fee_minor,
         provider_fee_minor, payer_total_minor, recipient_net_minor, fee_policy_version, expires_at)
       VALUES ($1, $2, 'NGN', $3, 20000, 0, $3, $4, 'test', now() + interval '1 hour')`,
      [quoteId, locationId, gross, netMinor],
    );
    await q(
      `INSERT INTO payment_intents (id, quote_id, team_location_id, idempotency_key,
         request_fingerprint, status, expires_at)
       VALUES ($1, $2, $3, $4, 'f', 'AWAITING_PAYMENT', now() + interval '1 hour')`,
      [intentId, quoteId, locationId, randomUUID()],
    );
    await q(
      `INSERT INTO tips (id, intent_id, team_location_id, currency, gross_minor, status)
       VALUES ($1, $2, $3, 'NGN', $4, 'AWAITING_PAYMENT')`,
      [tipId, intentId, locationId, gross],
    );
    return { tipId, intentId, quoteId };
  };

  await t.test(
    'a tip with neither or both of profile_id and team_location_id is refused',
    async () => {
      const { locationId } = await setUp();
      const { tipId, intentId } = await teamTip(locationId);
      // Today's intent route never pays a team quote: it reads as no quote (R2-D adds its own).
      await assert.rejects(
        createPaymentIntent(database.db, {
          quoteId: (await teamTip(locationId)).quoteId,
          idempotencyKey: randomUUID(),
        }),
        { code: 'QUOTE_NOT_FOUND' },
      );
      assert.equal(
        (await q(`SELECT profile_id FROM tips WHERE id = $1`, [tipId]))[0]
          .profile_id,
        null,
      );
      for (const sql of [
        `UPDATE tips SET team_location_id = NULL WHERE id = $1`,
        `UPDATE tips SET profile_id = '${ADA}' WHERE id = $1`,
      ])
        await refused(q(sql, [tipId]), /tips_recipient/);
      for (const sql of [
        `UPDATE payment_intents SET team_location_id = NULL WHERE id = $1`,
        `UPDATE payment_intents SET profile_id = '${ADA}' WHERE id = $1`,
      ])
        await refused(q(sql, [intentId]), /payment_intents_recipient/);
      await refused(
        q(
          `INSERT INTO tip_quotes (id, currency, tip_minor, platform_fee_minor, provider_fee_minor,
             payer_total_minor, recipient_net_minor, fee_policy_version, expires_at)
           VALUES ($1, 'NGN', 200000, 20000, 0, 200000, 180000, 'test', now())`,
          [randomUUID()],
        ),
        /tip_quotes_recipient/,
      );
      // Today's person tips are unchanged: a person, no location.
      const own = await tipAt();
      const [row] = await q(
        `SELECT profile_id, team_location_id FROM tips WHERE id = $1`,
        [own.tipId],
      );
      assert.deepEqual(row, { profile_id: ADA, team_location_id: null });
    },
  );

  await t.test(
    'a team split goes to members of that location, to their own page, and adds up to the net',
    async () => {
      const { locationId, memberId } = await setUp();
      const tobi = await seedMember(database, { locationId, profileId: TOBI });
      const { tipId } = await teamTip(locationId, 1000n);
      const split = (member, profile, amount) =>
        q(
          `INSERT INTO team_tip_splits (tip_id, member_id, profile_id, amount_minor) VALUES ($1, $2, $3, $4)`,
          [tipId, member, profile, amount],
        );
      await refused(split(memberId, TOBI, 500), /team_tip_splits_member/);
      const elsewhere = await seedBusiness(database);
      const stranger = await seedMember(database, {
        locationId: elsewhere.locations[0].id,
        profileId: TOBI,
      });
      await refused(
        split(stranger.memberId, TOBI, 500),
        /team_tip_splits_member/,
      );
      // A person tip has no split.
      const own = await tipAt(memberId);
      await refused(
        q(
          `INSERT INTO team_tip_splits (tip_id, member_id, profile_id, amount_minor) VALUES ($1, $2, $3, 1)`,
          [own.tipId, memberId, ADA],
        ),
        /team_tip_splits_member/,
      );
      // Parts that don't add up to the net are refused at commit.
      const client = await database.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO team_tip_splits (tip_id, member_id, profile_id, amount_minor) VALUES ($1, $2, $3, 600)`,
          [tipId, memberId, ADA],
        );
        await refused(client.query('COMMIT'), /team_tip_splits_total/);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
      const client2 = await database.pool.connect();
      try {
        await client2.query('BEGIN');
        await client2.query(
          `INSERT INTO team_tip_splits (tip_id, member_id, profile_id, amount_minor)
           VALUES ($1, $2, $3, 500), ($1, $4, $5, 500)`,
          [tipId, memberId, ADA, tobi.memberId, TOBI],
        );
        await client2.query('COMMIT');
      } finally {
        client2.release();
      }
      assert.equal(await database.count('team_tip_splits'), 2);
      await refused(
        q(`UPDATE team_tip_splits SET amount_minor = 1 WHERE tip_id = $1`, [
          tipId,
        ]),
        /append-only/,
      );
    },
  );

  await t.test(
    'a table card is assigned only to a member of its location, on their own shift',
    async () => {
      const { locationId, memberId } = await setUp();
      const { cardId, code } = await seedTableCard(database, { locationId });
      assert.match(code, /^[a-z2-7]{10}$/);
      const shift = async (member) => {
        const id = randomUUID();
        await q(
          `INSERT INTO business_shifts (id, member_id, started_at, started_by) VALUES ($1, $2, now(), 'self')`,
          [id, member],
        );
        return id;
      };
      const assign = (member, shiftId, card = cardId) =>
        q(
          `INSERT INTO table_assignments (id, card_id, member_id, shift_id, assigned_by, assigned_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [randomUUID(), card, member, shiftId, ADA_USER],
        );
      const adaShift = await shift(memberId);
      const tobi = await seedMember(database, { locationId, profileId: TOBI });
      const tobiShift = await shift(tobi.memberId);
      await refused(assign(memberId, tobiShift), /table_assignments_member/);
      const elsewhere = await seedBusiness(database);
      const farCard = await seedTableCard(database, {
        locationId: elsewhere.locations[0].id,
      });
      await refused(
        assign(memberId, adaShift, farCard.cardId),
        /table_assignments_member/,
      );
      await assign(memberId, adaShift);
      await refused(assign(tobi.memberId, tobiShift), /table_assignments_open/);
      await refused(
        q(
          `INSERT INTO table_cards (id, location_id, label, code, created_by) VALUES ($1, $2, 'T', 'ABCDEFGH23', $3)`,
          [randomUUID(), locationId, ADA_USER],
        ),
        /table_cards_code/,
      );
    },
  );

  const account = (code, values = {}) =>
    q(
      `INSERT INTO ledger_accounts (id, code, kind, currency, profile_id, business_id)
       VALUES ($1, $2, $3, 'NGN', $4, $5) RETURNING id`,
      [
        randomUUID(),
        code,
        values.kind ?? 'liability',
        values.profileId ?? null,
        values.businessId ?? null,
      ],
    ).then((rows) => rows[0].id);

  await t.test(
    'existing ledger accounts keep their identity after the migration (re-select by code, currency, profile)',
    async () => {
      const { businessId } = await setUp();
      // Accounts as release 1 makes them: global ones and a person's.
      const clearing = await account('provider_clearing', { kind: 'asset' });
      const ada = await account('recipient_payable', { profileId: ADA });
      // Replay the migration's identity change on these rows, as on production's.
      const dir = new URL('../../drizzle/', import.meta.url);
      const file = (await readdir(dir)).find((name) =>
        /^\d+_business_release2\.sql$/.test(name),
      );
      const parts = (await readFile(new URL(file, dir), 'utf8')).split(
        '--> statement-breakpoint',
      );
      const identity = parts.filter((part) =>
        /"ledger_accounts_identity"/.test(part),
      );
      assert.equal(identity.length, 2, 'the migration drops and re-adds it');
      for (const statement of identity) await q(statement);
      const reselect = (code, profileId) =>
        q(
          `SELECT id FROM ledger_accounts
            WHERE code = $1 AND currency = 'NGN' AND profile_id IS NOT DISTINCT FROM $2`,
          [code, profileId],
        );
      assert.deepEqual(await reselect('provider_clearing', null), [
        { id: clearing },
      ]);
      assert.deepEqual(await reselect('recipient_payable', ADA), [{ id: ada }]);
      // Still one global account per code and currency, one per person.
      await refused(
        account('provider_clearing', { kind: 'asset' }),
        /ledger_accounts_identity/,
      );
      await refused(
        account('recipient_payable', { profileId: ADA }),
        /ledger_accounts_identity/,
      );
      // A business's payable is its own account; only a business holds one, and nothing else.
      await account('business_payable', { businessId });
      await refused(
        account('business_payable', { businessId }),
        /ledger_accounts_identity/,
      );
      await refused(account('business_payable'), /business_payable/);
      await refused(
        account('recipient_payable', { businessId }),
        /business_payable/,
      );
      await refused(
        account('business_payable', { businessId, profileId: ADA }),
        /ledger_accounts_one_owner/,
      );
    },
  );

  await t.test(
    'a reversal names a payment of the same tip; an entry names its account’s business',
    async () => {
      const { businessId, memberId } = await setUp();
      const tip = await tipAt(memberId);
      const other = await tipAt(memberId);
      const clearing = await account('provider_clearing', { kind: 'asset' });
      const payable = await account('business_payable', { businessId });
      // Posts one balanced two-line transaction inside a SQL transaction.
      const post = async (values) => {
        const client = await database.pool.connect();
        const id = randomUUID();
        try {
          await client.query('BEGIN');
          await client.query(
            `INSERT INTO ledger_transactions (id, operation_type, operation_key, currency, tip_id, reverses_transaction_id)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              id,
              values.type,
              values.key ?? randomUUID(),
              values.currency ?? 'NGN',
              values.tipId,
              values.reverses ?? null,
            ],
          );
          for (const [accountId, side, entryBusiness] of [
            [clearing, values.flip ? 'credit' : 'debit', null],
            [
              payable,
              values.flip ? 'debit' : 'credit',
              values.entryBusiness === undefined
                ? businessId
                : values.entryBusiness,
            ],
          ])
            await client.query(
              `INSERT INTO ledger_entries (id, transaction_id, account_id, business_id, side, amount_minor, currency)
               VALUES ($1, $2, $3, $4, $5, 100, 'NGN')`,
              [randomUUID(), id, accountId, entryBusiness, side],
            );
          await client.query('COMMIT');
          return id;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      await refused(
        post({ type: 'payment', tipId: tip.tipId, entryBusiness: null }),
        /ledger_entries_business_account/,
      );
      const payment = await post({ type: 'payment', tipId: tip.tipId });
      // Without naming what it reverses, or naming another tip's payment or itself as a reversal.
      await refused(
        post({ type: 'reversal', tipId: tip.tipId, flip: true }),
        /ledger_transactions_reversal/,
      );
      await refused(
        post({ type: 'payment', tipId: tip.tipId, reverses: payment }),
        /ledger_transactions_reversal/,
      );
      await refused(
        post({
          type: 'reversal',
          tipId: other.tipId,
          reverses: payment,
          flip: true,
        }),
        /ledger_transactions_reversal_target/,
      );
      const key = `reversal.${randomUUID()}`;
      const reversal = await post({
        type: 'reversal',
        tipId: tip.tipId,
        reverses: payment,
        key,
        flip: true,
      });
      await refused(
        post({
          type: 'reversal',
          tipId: tip.tipId,
          reverses: reversal,
          flip: true,
        }),
        /ledger_transactions_reversal_target/,
      );
      // The same provider event can't post a second reversal.
      await refused(
        post({
          type: 'reversal',
          tipId: tip.tipId,
          reverses: payment,
          key,
          flip: true,
        }),
        /operation_key/,
      );
    },
  );

  await t.test(
    'a business can hold its own payment account, destination and withdrawal; exactly one owner each',
    async () => {
      const { businessId } = await setUp();
      const paymentAccount = (profileId, business) =>
        q(
          `INSERT INTO payment_accounts (id, profile_id, business_id, provider, environment, status)
           VALUES ($1, $2, $3, 'bachs', 'sandbox', 'CREATING')`,
          [randomUUID(), profileId, business],
        );
      await paymentAccount(null, businessId);
      await refused(
        paymentAccount(null, businessId),
        /payment_accounts_business_provider_environment/,
      );
      await refused(paymentAccount(null, null), /payment_accounts_owner/);
      await refused(paymentAccount(ADA, businessId), /payment_accounts_owner/);
      const destination = (profileId, business) =>
        q(
          `INSERT INTO payout_destinations (id, profile_id, business_id, provider, destination_reference,
             bank_code, bank_name, account_last4, status)
           VALUES ($1, $2, $3, 'bachs', 'ref', '058', 'Bank', '1234', 'usable')`,
          [randomUUID(), profileId, business],
        );
      await destination(null, businessId);
      await refused(
        destination(null, businessId),
        /payout_destinations_business_active/,
      );
      await refused(destination(null, null), /payout_destinations_owner/);
      const payout = (profileId, business) =>
        q(
          `INSERT INTO payouts (id, profile_id, business_id, currency, amount_minor, status,
             idempotency_key, request_fingerprint)
           VALUES ($1, $2, $3, 'NGN', 1000, 'REQUESTED', $4, 'f')`,
          [randomUUID(), profileId, business, randomUUID()],
        );
      await payout(null, businessId);
      await refused(payout(null, null), /payouts_owner/);
      await refused(payout(ADA, businessId), /payouts_owner/);
    },
  );

  await t.test(
    'share reports and the release 2 issue kinds are known to the database',
    async () => {
      const { businessId, memberId } = await setUp();
      await q(
        `INSERT INTO share_reports (id, member_id, business_id, reason) VALUES ($1, $2, $3, 'pressure')`,
        [randomUUID(), memberId, businessId],
      );
      await refused(
        q(
          `INSERT INTO share_reports (id, member_id, business_id, reason) VALUES ($1, $2, $3, 'angry')`,
          [randomUUID(), memberId, businessId],
        ),
        /share_reports_reason/,
      );
      for (const kind of ['share_report', 'balance_below_zero'])
        await q(
          `INSERT INTO issues (id, dedupe_key, kind, severity, subject, summary, opened_at)
           VALUES ($1, $2, $3, 'account', '{}', 's', now())`,
          [randomUUID(), randomUUID(), kind],
        );
    },
  );
});
