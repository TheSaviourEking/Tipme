import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  createPaymentIntent,
  createQuote,
  deleteAccount,
  leaveBusiness,
  listMembers,
  mailSealing,
  myWork,
  removeMember,
  updateMyMembership,
} from '../../dist/index.js';
import { seedBusiness, seedManager, seedMember } from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B3 Task 12: removing, leaving, how a person shows at a business, and
// what deleting an account does to business roles (M13).

const sealing = mailSealing(Buffer.alloc(32, 7));
const [ADA, TOBI] = DEMO_PROFILES;
const rejects = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });

test('business membership', async (t) => {
  const database = await useDatabase(t);
  const q = (text, values) =>
    database.pool.query(text, values).then((result) => result.rows);
  const setUp = async () => {
    await database.fresh();
    return seedBusiness(database, {
      owner: TOBI.userId,
      locations: [
        { slug: 'vi', name: 'Victoria Island' },
        { slug: 'ikoyi', name: 'Ikoyi' },
      ],
    });
  };
  await t.test(
    'removing or leaving is instant: the person is gone from members and the open shift ends',
    async () => {
      const business = await setUp();
      const [vi] = business.locations;
      const { memberId } = await seedMember(database, {
        locationId: vi.id,
        profileId: ADA.id,
        onShift: true,
      });
      const listed = await listMembers(
        database.db,
        TOBI.userId,
        business.businessId,
      );
      assert.equal(listed.length, 1);
      assert.equal(listed[0].onShift, true);
      assert.equal(listed[0].profileHandle, 'ada');
      await removeMember(
        database.db,
        TOBI.userId,
        business.businessId,
        memberId,
      );
      assert.deepEqual(
        await listMembers(database.db, TOBI.userId, business.businessId),
        [],
      );
      const [ended] = await q(
        `SELECT bm.left_by, s.ended_by FROM business_members bm JOIN business_shifts s ON s.member_id = bm.id WHERE bm.id = $1`,
        [memberId],
      );
      assert.deepEqual(ended, { left_by: 'manager', ended_by: 'left' });
      // Removing again: not found.
      await rejects(
        removeMember(database.db, TOBI.userId, business.businessId, memberId),
        'NO_MEMBERSHIP',
      );
      // Leaving.
      const second = await seedMember(database, {
        locationId: vi.id,
        profileId: ADA.id,
        onShift: true,
      });
      await rejects(
        leaveBusiness(database.db, TOBI.userId, second.memberId),
        'NO_MEMBERSHIP',
      );
      await leaveBusiness(database.db, ADA.userId, second.memberId);
      assert.deepEqual(await myWork(database.db, ADA.userId), []);
      const [left] = await q(
        `SELECT bm.left_by, s.ended_by FROM business_members bm JOIN business_shifts s ON s.member_id = bm.id WHERE bm.id = $1`,
        [second.memberId],
      );
      assert.deepEqual(left, { left_by: 'self', ended_by: 'left' });
    },
  );

  await t.test(
    'a location manager removes and lists only at their location; another business is not found',
    async () => {
      const business = await setUp();
      const [vi, ikoyi] = business.locations;
      await seedManager(database, {
        businessId: business.businessId,
        userId: ADA.userId,
        locationId: vi.id,
      });
      const atVi = await seedMember(database, {
        locationId: vi.id,
        profileId: TOBI.id,
      });
      const atIkoyi = await seedMember(database, {
        locationId: ikoyi.id,
        profileId: ADA.id,
      });
      assert.deepEqual(
        (await listMembers(database.db, ADA.userId, business.businessId)).map(
          (m) => m.memberId,
        ),
        [atVi.memberId],
      );
      await rejects(
        listMembers(database.db, ADA.userId, business.businessId, ikoyi.id),
        'NOT_A_MANAGER',
      );
      await rejects(
        removeMember(
          database.db,
          ADA.userId,
          business.businessId,
          atIkoyi.memberId,
        ),
        'NOT_A_MANAGER',
      );
      const other = await seedBusiness(database, { owner: ADA.userId });
      await rejects(
        removeMember(database.db, ADA.userId, other.businessId, atVi.memberId),
        'NO_MEMBERSHIP',
      );
      await rejects(
        listMembers(database.db, TOBI.userId, other.businessId),
        'NOT_A_MANAGER',
      );
      await removeMember(
        database.db,
        ADA.userId,
        business.businessId,
        atVi.memberId,
      );
    },
  );

  await t.test('their tips, balance and notes are untouched', async () => {
    const business = await setUp();
    const [vi] = business.locations;
    const { memberId } = await seedMember(database, {
      locationId: vi.id,
      profileId: ADA.id,
    });
    // A tip made at the business, with a note about Ada.
    const quote = await createQuote(database.db, {
      handle: 'ada',
      tipMinor: 200000n,
      currency: 'NGN',
    });
    const { tipId } = await createPaymentIntent(database.db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
      businessMemberId: memberId,
    });
    await q(
      `INSERT INTO business_notes (tip_id, member_id, tags) VALUES ($1, $2, ARRAY['friendly'])`,
      [tipId, memberId],
    );
    const snapshot = async () =>
      JSON.stringify(
        await q(`SELECT
          (SELECT coalesce(json_agg(t ORDER BY t.id), '[]') FROM (SELECT id, status, business_member_id, profile_id FROM tips) t) AS tips,
          (SELECT coalesce(json_agg(e ORDER BY e.id), '[]') FROM (SELECT id, amount_minor FROM ledger_entries) e) AS entries,
          (SELECT coalesce(json_agg(n ORDER BY n.tip_id), '[]') FROM business_notes n) AS notes`),
      );
    const before = await snapshot();
    await leaveBusiness(database.db, ADA.userId, memberId);
    assert.equal(await snapshot(), before);
  });

  await t.test(
    'a person can belong to two businesses and two locations of one business',
    async () => {
      const business = await setUp();
      const other = await seedBusiness(database, {
        owner: TOBI.userId,
        name: 'Zed Salon',
        locations: [{ slug: 'lekki', name: 'Lekki' }],
      });
      for (const locationId of [
        business.locations[0].id,
        business.locations[1].id,
        other.locations[0].id,
      ])
        await seedMember(database, { locationId, profileId: ADA.id });
      const work = await myWork(database.db, ADA.userId);
      assert.deepEqual(
        work.map((m) => `${m.business.name} · ${m.location.name}`),
        [
          'The Yellow Chilli · Ikoyi',
          'The Yellow Chilli · Victoria Island',
          'Zed Salon · Lekki',
        ],
      );
      assert.equal(work[0].shareAmounts, false);
      assert.equal(work[0].onShift, false);
    },
  );

  await t.test(
    'rejoining after leaving makes a new membership id',
    async () => {
      const business = await setUp();
      const first = await seedMember(database, {
        locationId: business.locations[0].id,
        profileId: ADA.id,
      });
      await leaveBusiness(database.db, ADA.userId, first.memberId);
      const again = await seedMember(database, {
        locationId: business.locations[0].id,
        profileId: ADA.id,
      });
      assert.notEqual(again.memberId, first.memberId);
      assert.deepEqual(
        (await myWork(database.db, ADA.userId)).map((m) => m.memberId),
        [again.memberId],
      );
    },
  );

  await t.test(
    'the person chooses the name on their card and whether their photo shows',
    async () => {
      const business = await setUp();
      const { memberId } = await seedMember(database, {
        locationId: business.locations[0].id,
        profileId: ADA.id,
      });
      const updated = await updateMyMembership(
        database.db,
        ADA.userId,
        memberId,
        {
          shownName: 'Ada O.',
          showPhoto: false,
        },
      );
      assert.equal(updated.shownName, 'Ada O.');
      assert.equal(updated.showPhoto, false);
      const kept = await updateMyMembership(database.db, ADA.userId, memberId, {
        showPhoto: true,
      });
      assert.equal(kept.shownName, 'Ada O.');
      assert.equal(kept.showPhoto, true);
      await rejects(
        updateMyMembership(database.db, TOBI.userId, memberId, {
          showPhoto: false,
        }),
        'NO_MEMBERSHIP',
      );
      await rejects(
        updateMyMembership(database.db, ADA.userId, randomUUID(), {
          showPhoto: false,
        }),
        'NO_MEMBERSHIP',
      );
    },
  );

  await t.test(
    'deleting an account ends memberships; the last owner of a verified business is refused',
    async () => {
      const business = await setUp();
      const { memberId } = await seedMember(database, {
        locationId: business.locations[0].id,
        profileId: ADA.id,
        onShift: true,
      });
      await seedManager(database, {
        businessId: business.businessId,
        userId: ADA.userId,
        locationId: business.locations[1].id,
      });
      await q(
        `INSERT INTO business_invitation_blocks (business_id, user_id) VALUES ($1, $2)`,
        [business.businessId, ADA.userId],
      );
      // Tobi is the only owner of a verified business: refused, and nothing changes.
      await rejects(
        deleteAccount(database.db, { userId: TOBI.userId, sealing }),
        'BUSINESS_LAST_OWNER',
      );
      const [tobi] = await q(`SELECT deleted_at FROM users WHERE id = $1`, [
        TOBI.userId,
      ]);
      assert.equal(tobi.deleted_at, null);
      // Ada may go: her place on the team, her shift, her manager seat and her block end.
      await deleteAccount(database.db, { userId: ADA.userId, sealing });
      const [member] = await q(
        `SELECT bm.left_by, s.ended_by FROM business_members bm JOIN business_shifts s ON s.member_id = bm.id WHERE bm.id = $1`,
        [memberId],
      );
      assert.deepEqual(member, {
        left_by: 'account_deleted',
        ended_by: 'left',
      });
      const seats = await q(
        `SELECT removed_at FROM business_managers WHERE user_id = $1`,
        [ADA.userId],
      );
      assert.equal(seats.length, 1);
      assert.ok(seats[0].removed_at);
      assert.equal(
        (
          await q(`SELECT count(*)::int AS n FROM business_invitation_blocks`)
        )[0].n,
        0,
      );
      // With a second owner, Tobi may go too.
      const kemiUser = randomUUID();
      await q(
        `INSERT INTO users (id, phone_e164) VALUES ($1, '+2348000000999')`,
        [kemiUser],
      );
      await seedManager(database, {
        businessId: business.businessId,
        userId: kemiUser,
      });
      await deleteAccount(database.db, { userId: TOBI.userId, sealing });
      // The only owner of a business still waiting for verification is not held back.
      await database.fresh();
      await seedBusiness(database, { owner: ADA.userId, status: 'pending' });
      await deleteAccount(database.db, { userId: ADA.userId, sealing });
    },
  );
});
