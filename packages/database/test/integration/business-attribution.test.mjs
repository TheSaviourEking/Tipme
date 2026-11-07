import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createPaymentIntent,
  createQuote,
  recordProviderEvent,
} from '../../dist/index.js';
import { leaveMember, seedBusiness, seedMember } from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B0 Task 3: a tip made at a business carries a label of where it was
// made. The label can never block, refuse or redirect a tip, and no posting reads it.

test('business attribution', async (t) => {
  const database = await useDatabase(t);
  const q = (text, values) =>
    database.pool.query(text, values).then((result) => result.rows);
  const quote = () =>
    createQuote(database.db, {
      handle: 'ada',
      tipMinor: 200000n,
      currency: 'NGN',
    });
  const labelOf = async (tipId) =>
    (
      await q(
        `SELECT business_member_id, business_location_id, profile_id, gross_minor::text AS gross
           FROM tips WHERE id = $1`,
        [tipId],
      )
    )[0];
  const tipAt = async (businessMemberId) =>
    createPaymentIntent(database.db, {
      quoteId: (await quote()).quoteId,
      idempotencyKey: randomUUID(),
      ...(businessMemberId === undefined ? {} : { businessMemberId }),
    });

  await t.test(
    'a tip with an active member of this page at a verified business is labelled with member and location',
    async () => {
      await database.fresh();
      const { locations } = await seedBusiness(database);
      const { memberId } = await seedMember(database, {
        locationId: locations[0].id,
        profileId: ADA,
      });
      const { tipId } = await tipAt(memberId);
      assert.deepEqual(await labelOf(tipId), {
        business_member_id: memberId,
        business_location_id: locations[0].id,
        profile_id: ADA,
        gross: '200000',
      });
    },
  );

  await t.test(
    'a member of another page, a left member, a closed location, a pending or suspended business: tip made, no label',
    async () => {
      await database.fresh();
      const verified = await seedBusiness(database, {
        locations: [{ slug: 'vi' }, { slug: 'ikoyi', closed: true }],
      });
      const pending = await seedBusiness(database, { status: 'pending' });
      const suspended = await seedBusiness(database, { status: 'suspended' });
      const cases = {
        'another page': (
          await seedMember(database, {
            locationId: verified.locations[0].id,
            profileId: TOBI,
          })
        ).memberId,
        'a closed location': (
          await seedMember(database, {
            locationId: verified.locations[1].id,
            profileId: ADA,
          })
        ).memberId,
        'a pending business': (
          await seedMember(database, {
            locationId: pending.locations[0].id,
            profileId: ADA,
          })
        ).memberId,
        'a suspended business': (
          await seedMember(database, {
            locationId: suspended.locations[0].id,
            profileId: ADA,
          })
        ).memberId,
        'an unknown member': randomUUID(),
        'not an id at all': 'tobi',
      };
      const left = await seedMember(database, {
        locationId: verified.locations[0].id,
        profileId: ADA,
      });
      await leaveMember(database, left.memberId);
      cases['a left member'] = left.memberId;
      for (const [name, memberId] of Object.entries(cases)) {
        const { tipId, replayed } = await tipAt(memberId);
        assert.equal(replayed, false, name);
        assert.deepEqual(
          await labelOf(tipId),
          {
            business_member_id: null,
            business_location_id: null,
            profile_id: ADA,
            gross: '200000',
          },
          name,
        );
      }
    },
  );

  await t.test(
    'fingerprint without businessMemberId is byte-identical to before (golden hash from today)',
    async () => {
      await database.fresh();
      const { quoteId } = await quote();
      const { intentId } = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
        payerDisplayLabel: 'Chidi',
        message: 'Thank you',
      });
      // Today's fingerprint (dev at b86c7b99): quote, label, message, moment.
      const before = createHash('sha256')
        .update(JSON.stringify([quoteId, 'Chidi', 'Thank you', null]))
        .digest('hex');
      const [row] = await q(
        'SELECT request_fingerprint FROM payment_intents WHERE id = $1',
        [intentId],
      );
      assert.equal(row.request_fingerprint, before);
    },
  );

  await t.test(
    'an ignored member hashes as a request without one',
    async () => {
      await database.fresh();
      const { quoteId } = await quote();
      const { intentId } = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: randomUUID(),
        businessMemberId: randomUUID(),
      });
      const [row] = await q(
        'SELECT request_fingerprint FROM payment_intents WHERE id = $1',
        [intentId],
      );
      assert.equal(
        row.request_fingerprint,
        createHash('sha256')
          .update(JSON.stringify([quoteId, null, null, null]))
          .digest('hex'),
      );
    },
  );

  await t.test(
    'same key, same member: replay; same key, member added: IDEMPOTENCY_CONFLICT',
    async () => {
      await database.fresh();
      const { locations } = await seedBusiness(database);
      const { memberId } = await seedMember(database, {
        locationId: locations[0].id,
        profileId: ADA,
      });
      const send = (quoteId, key, businessMemberId) =>
        createPaymentIntent(database.db, {
          quoteId,
          idempotencyKey: key,
          ...(businessMemberId ? { businessMemberId } : {}),
        });
      const first = await quote();
      const key = randomUUID();
      const made = await send(first.quoteId, key, memberId);
      const again = await send(first.quoteId, key, memberId);
      assert.equal(again.replayed, true);
      assert.equal(again.tipId, made.tipId);

      const second = await quote();
      const plainKey = randomUUID();
      await send(second.quoteId, plainKey);
      await assert.rejects(send(second.quoteId, plainKey, memberId), {
        code: 'IDEMPOTENCY_CONFLICT',
      });

      // A stale page: the member was ignored the first time and is sent again, still ignored.
      const third = await quote();
      const staleKey = randomUUID();
      const stale = randomUUID();
      await send(third.quoteId, staleKey, stale);
      assert.equal((await send(third.quoteId, staleKey, stale)).replayed, true);
      assert.equal((await send(third.quoteId, staleKey)).replayed, true);
    },
  );

  await t.test(
    'a retry after the membership ended replays the labelled tip instead of refusing it',
    async () => {
      await database.fresh();
      const { locations } = await seedBusiness(database);
      const { memberId } = await seedMember(database, {
        locationId: locations[0].id,
        profileId: ADA,
      });
      const { quoteId } = await quote();
      const key = randomUUID();
      const made = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: key,
        businessMemberId: memberId,
      });
      await leaveMember(database, memberId);
      const retried = await createPaymentIntent(database.db, {
        quoteId,
        idempotencyKey: key,
        businessMemberId: memberId,
      });
      assert.equal(retried.replayed, true);
      assert.equal(retried.tipId, made.tipId);
      assert.equal((await labelOf(made.tipId)).business_member_id, memberId);
    },
  );

  await t.test(
    'a paid business tip posts exactly the same ledger lines as a plain tip of the same amount',
    async () => {
      await database.fresh();
      const { locations } = await seedBusiness(database);
      const { memberId } = await seedMember(database, {
        locationId: locations[0].id,
        profileId: ADA,
      });
      const pay = async (businessMemberId) => {
        const { tipId, attemptId } = await tipAt(businessMemberId);
        await recordProviderEvent(database.db, {
          provider: 'mock',
          providerEventId: randomUUID(),
          eventType: 'payment.succeeded',
          attemptId,
          providerReference: `ref-${attemptId}`,
          amountMinor: 200000n,
          currency: 'NGN',
          providerFeeMinor: 1500n,
          signatureVerified: true,
          payload: { kind: 'test' },
        });
        return q(
          `SELECT a.code, a.profile_id, e.side, e.amount_minor::text AS amount, e.currency
             FROM ledger_transactions x
             JOIN ledger_entries e ON e.transaction_id = x.id
             JOIN ledger_accounts a ON a.id = e.account_id
            WHERE x.tip_id = $1
            ORDER BY a.code, e.side, e.amount_minor`,
          [tipId],
        );
      };
      const plain = await pay(undefined);
      const atBusiness = await pay(memberId);
      assert.ok(plain.length >= 2);
      assert.deepEqual(atBusiness, plain);
      assert.ok(
        atBusiness.some(
          (line) =>
            line.code === 'recipient_payable' && line.profile_id === ADA,
        ),
      );
    },
  );
});
