import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  endShift,
  expireShifts,
  startShift,
} from '../../dist/index.js';
import {
  leaveMember,
  seedBusiness,
  seedManager,
  seedMember,
} from './business-fixtures.mjs';
import { ADA, TOBI, useDatabase } from './helpers.mjs';

// TipMe for businesses, PR B6: check in and out, by the person or a manager, and the 14-hour end.

const [ADA_P, TOBI_P] = DEMO_PROFILES;
const HOUR = 3_600_000;
const code = (name) => (error) => {
  assert.equal(error.code, name);
  return true;
};

async function world(database, options = {}) {
  const business = await seedBusiness(database, {
    owner: TOBI_P.userId,
    locations: [{ slug: 'vi' }, { slug: 'ikoyi' }],
    ...options,
  });
  const { memberId } = await seedMember(database, {
    locationId: business.locations[0].id,
    profileId: ADA,
  });
  return { business, memberId };
}

const shiftsOf = async (database, memberId) =>
  (
    await database.pool.query(
      `SELECT started_at, started_by, ended_at, ended_by FROM business_shifts
        WHERE member_id = $1 ORDER BY started_at`,
      [memberId],
    )
  ).rows;

async function extraUser(database) {
  const userId = randomUUID();
  await database.pool.query(`INSERT INTO users (id) VALUES ($1)`, [userId]);
  return userId;
}

test('business shifts', async (t) => {
  const database = await useDatabase(t);
  const self = { userId: ADA_P.userId, as: 'self' };

  await t.test(
    'a person checks in and out; a second start is the same shift',
    async () => {
      await database.fresh();
      const { business, memberId } = await world(database);
      const now = new Date('2026-11-06T17:02:00Z');
      const first = await startShift(database.db, self, memberId, now);
      assert.deepEqual(first, {
        startedAt: now.toISOString(),
        businessSlug: business.slug,
        changed: true,
      });
      const again = await startShift(
        database.db,
        self,
        memberId,
        new Date(now.getTime() + 60_000),
      );
      assert.equal(again.startedAt, now.toISOString());
      assert.equal(again.changed, false);
      const ended = await endShift(
        database.db,
        self,
        memberId,
        new Date(now.getTime() + 2 * HOUR),
      );
      assert.deepEqual(ended, { businessSlug: business.slug, changed: true });
      // No open shift: a no-op.
      assert.equal(
        (await endShift(database.db, self, memberId, new Date())).changed,
        false,
      );
      const rows = await shiftsOf(database, memberId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].started_by, 'self');
      assert.equal(rows[0].ended_by, 'self');
    },
  );

  await t.test("someone else's membership is not found", async () => {
    await database.fresh();
    const { memberId } = await world(database);
    await assert.rejects(
      startShift(database.db, { userId: TOBI_P.userId, as: 'self' }, memberId),
      code('NO_MEMBERSHIP'),
    );
    await assert.rejects(
      startShift(database.db, self, 'not-a-uuid'),
      code('NO_MEMBERSHIP'),
    );
    await leaveMember(database, memberId);
    await assert.rejects(
      startShift(database.db, self, memberId),
      code('NO_MEMBERSHIP'),
    );
  });

  await t.test(
    'a manager checks someone in; a manager of another location cannot',
    async () => {
      await database.fresh();
      const { business, memberId } = await world(database);
      const owner = {
        userId: TOBI_P.userId,
        as: 'manager',
        businessId: business.businessId,
      };
      const started = await startShift(database.db, owner, memberId);
      assert.equal(started.changed, true);
      assert.equal(
        (await shiftsOf(database, memberId))[0].started_by,
        'manager',
      );

      // A manager of the member's own location may; one of the other location may not.
      const here = await extraUser(database);
      await seedManager(database, {
        businessId: business.businessId,
        userId: here,
        locationId: business.locations[0].id,
      });
      const there = await extraUser(database);
      await seedManager(database, {
        businessId: business.businessId,
        userId: there,
        locationId: business.locations[1].id,
      });
      const asManager = (userId) => ({
        userId,
        as: 'manager',
        businessId: business.businessId,
      });
      await assert.rejects(
        endShift(database.db, asManager(there), memberId),
        code('NOT_A_MANAGER'),
      );
      assert.equal(
        (await endShift(database.db, asManager(here), memberId)).changed,
        true,
      );
      assert.equal((await shiftsOf(database, memberId))[0].ended_by, 'manager');

      // Another business's manager, or this business's id with another business's member.
      const other = await seedBusiness(database, { owner: ADA_P.userId });
      const { memberId: elsewhere } = await seedMember(database, {
        locationId: other.locations[0].id,
        profileId: TOBI,
      });
      await assert.rejects(
        startShift(
          database.db,
          {
            userId: ADA_P.userId,
            as: 'manager',
            businessId: business.businessId,
          },
          memberId,
        ),
        code('NOT_A_MANAGER'),
      );
      await assert.rejects(
        startShift(database.db, owner, elsewhere),
        code('NO_MEMBERSHIP'),
      );
    },
  );

  await t.test(
    'a closed location or a business that is not verified refuses a start',
    async () => {
      await database.fresh();
      const closed = await world(database, {
        locations: [{ slug: 'vi', closed: true }],
      });
      await assert.rejects(
        startShift(database.db, self, closed.memberId),
        code('NO_MEMBERSHIP'),
      );
      const paused = await world(database, { status: 'suspended' });
      await assert.rejects(
        startShift(database.db, self, paused.memberId),
        code('BUSINESS_NOT_VERIFIED'),
      );
      const pending = await world(database, { status: 'pending' });
      await assert.rejects(
        startShift(database.db, self, pending.memberId),
        code('BUSINESS_NOT_VERIFIED'),
      );
      // Ending is always allowed: it only hides someone.
      await database.pool.query(
        `INSERT INTO business_shifts (id, member_id, started_at, started_by) VALUES ($1, $2, now(), 'self')`,
        [randomUUID(), paused.memberId],
      );
      assert.equal(
        (await endShift(database.db, self, paused.memberId)).changed,
        true,
      );
    },
  );

  await t.test(
    'a shift open for 14h01m is closed as expired on the next start',
    async () => {
      await database.fresh();
      const { memberId } = await world(database);
      const then = new Date('2026-11-05T08:00:00Z');
      await startShift(database.db, self, memberId, then);
      const later = new Date(then.getTime() + 14 * HOUR + 60_000);
      const next = await startShift(database.db, self, memberId, later);
      assert.equal(next.startedAt, later.toISOString());
      assert.equal(next.changed, true);
      const rows = await shiftsOf(database, memberId);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].ended_by, 'expired');
      // Ended when it ran out, not when it was noticed.
      assert.equal(
        rows[0].ended_at.toISOString(),
        new Date(then.getTime() + 14 * HOUR).toISOString(),
      );
      assert.equal(rows[1].ended_at, null);
    },
  );

  await t.test('a check-out after 14 hours closes it as expired', async () => {
    await database.fresh();
    const { memberId } = await world(database);
    const then = new Date('2026-11-05T08:00:00Z');
    await startShift(database.db, self, memberId, then);
    const change = await endShift(
      database.db,
      self,
      memberId,
      new Date(then.getTime() + 15 * HOUR),
    );
    // Already off the public page once it ran out.
    assert.equal(change.changed, false);
    const [row] = await shiftsOf(database, memberId);
    assert.equal(row.ended_by, 'expired');
  });

  await t.test('expireShifts closes only shifts that ran out', async () => {
    await database.fresh();
    const { memberId: stale } = await world(database);
    const { memberId: fresh } = await world(database);
    const now = new Date('2026-11-06T12:00:00Z');
    await startShift(
      database.db,
      self,
      stale,
      new Date(now.getTime() - 15 * HOUR),
    );
    await startShift(
      database.db,
      self,
      fresh,
      new Date(now.getTime() - 13 * HOUR),
    );
    assert.equal(await expireShifts(database.db, now), 1);
    assert.equal(await expireShifts(database.db, now), 0);
    assert.equal((await shiftsOf(database, stale))[0].ended_by, 'expired');
    assert.equal((await shiftsOf(database, fresh))[0].ended_at, null);
  });

  await t.test('two starts at once leave one open shift', async () => {
    await database.fresh();
    const { memberId } = await world(database);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => startShift(database.db, self, memberId)),
    );
    const open = (await shiftsOf(database, memberId)).filter(
      (row) => row.ended_at === null,
    );
    assert.equal(open.length, 1);
    assert.equal(results.filter((result) => result.changed).length, 1);
    assert.equal(new Set(results.map((result) => result.startedAt)).size, 1);
  });
});
