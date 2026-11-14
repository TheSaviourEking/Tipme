import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DEMO_PROFILES,
  acceptBusinessInvitation,
  addLocation,
  businessUsage,
  inviteToBusiness,
  mailSealing,
} from '../../dist/index.js';
import {
  leaveMember,
  seedBusiness,
  seedManager,
  seedMember,
} from './business-fixtures.mjs';
import { useDatabase } from './helpers.mjs';

// Business Pro, plan Task A4 (owner, 14 Nov 2026): Free 3 staff and 1 location, Pro 25 and 25.
// Owners never count; a business over a limit keeps everyone and only stops adding.

const sealing = mailSealing(Buffer.alloc(32, 7));
const [ADA, TOBI] = DEMO_PROFILES;
const ON = { enforceLimits: true };
const codeOf = (link) => link.split('#join=')[1];
const refused = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.equal(error.code, code);
    return true;
  });

/** Another TipMe account with a live page. */
async function person(database) {
  const userId = randomUUID();
  const profileId = randomUUID();
  const handle = `staff${randomUUID().replaceAll('-', '').slice(0, 10)}`;
  await database.pool.query(
    `INSERT INTO users (id, phone_e164) VALUES ($1, $2)`,
    [
      userId,
      `+23481${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`,
    ],
  );
  await database.pool.query(
    `INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state, status, visibility)
     VALUES ($1, $2, $3, $3, 'Staff Person', 'live', 'active', 'public')`,
    [profileId, userId, handle],
  );
  return { userId, profileId, handle };
}

async function setup(t, { locations = [{ slug: 'vi' }] } = {}) {
  const database = await useDatabase(t);
  await database.fresh();
  // Ada owns it.
  const business = await seedBusiness(database, {
    owner: ADA.userId,
    locations,
  });
  const locationId = business.locations[0].id;
  const q = (text, values) =>
    database.pool.query(text, values).then((result) => result.rows);
  const setPlan = (plan) =>
    q(`UPDATE businesses SET plan = $2 WHERE id = $1`, [
      business.businessId,
      plan,
    ]);
  const invite = (by = ADA.userId, opts = ON, email) =>
    inviteToBusiness(
      database.db,
      sealing,
      by,
      business.businessId,
      {
        kind: 'staff',
        locationId,
        target: {
          kind: 'email',
          email: email ?? `${randomUUID()}@example.com`,
        },
      },
      new Date(),
      opts,
    );
  const link = (opts = ON) =>
    inviteToBusiness(
      database.db,
      sealing,
      ADA.userId,
      business.businessId,
      { kind: 'staff', locationId, target: { kind: 'link' } },
      new Date(),
      opts,
    );
  const member = async (at = locationId) => {
    const someone = await person(database);
    const { memberId } = await seedMember(database, {
      locationId: at,
      profileId: someone.profileId,
    });
    return { ...someone, memberId };
  };
  const usage = () => businessUsage(database.db, business.businessId);
  return {
    database,
    business,
    locationId,
    q,
    setPlan,
    invite,
    link,
    member,
    usage,
  };
}

test('a free business invites a 3rd person but not a 4th', async (t) => {
  const { invite, member, usage } = await setup(t);
  await member();
  await member();
  const email = `${randomUUID()}@example.com`;
  const third = await invite(ADA.userId, ON, email);
  assert.deepEqual((await usage()).staff, { used: 3, limit: 3 });
  await refused(invite(), 'BUSINESS_STAFF_LIMIT');
  // The same open invitation again is not a new seat: it answers the same invitation.
  assert.equal((await invite(ADA.userId, ON, email)).id, third.id);
});

test('owners never count toward the staff limit', async (t) => {
  const { database, locationId, invite, member, usage } = await setup(t);
  // Ada (an owner) also works a shift there with her own page.
  await seedMember(database, { locationId, profileId: ADA.id });
  await member();
  await member();
  assert.deepEqual((await usage()).staff, { used: 2, limit: 3 });
  await invite(); // the 3rd seat: Ada isn't one
  assert.equal((await usage()).staff.used, 3);
  await refused(invite(), 'BUSINESS_STAFF_LIMIT');
});

test('one person at two locations counts once, and a closed location still counts its people', async (t) => {
  const { database, business, usage } = await setup(t, {
    locations: [{ slug: 'vi' }, { slug: 'ikoyi', closed: true }],
  });
  const someone = await person(database);
  for (const location of business.locations)
    await seedMember(database, {
      locationId: location.id,
      profileId: someone.profileId,
    });
  const other = await person(database);
  await seedMember(database, {
    locationId: business.locations[1].id,
    profileId: other.profileId,
  });
  const result = await usage();
  assert.deepEqual(result.staff, { used: 2, limit: 3 });
  // Closed locations don't count toward the location limit.
  assert.deepEqual(result.locations, { used: 1, limit: 1 });
  assert.equal(result.plan, 'free');
});

test('accepting re-checks: the 4th accept is refused and the invitation stays open', async (t) => {
  const { database, q, link, member } = await setup(t);
  const created = await link();
  await member();
  await member();
  await member();
  const joiner = await person(database);
  await refused(
    acceptBusinessInvitation(
      database.db,
      joiner.userId,
      { code: codeOf(created.link) },
      new Date(),
      ON,
    ),
    'BUSINESS_STAFF_LIMIT',
  );
  const [row] = await q(
    `SELECT accepted_at, revoked_at FROM business_invitations WHERE id = $1`,
    [created.id],
  );
  assert.equal(row.accepted_at, null);
  assert.equal(row.revoked_at, null);
});

test('accepting is fine while the business is below its limit', async (t) => {
  const { database, link, member, usage } = await setup(t);
  const created = await link();
  await member();
  const joiner = await person(database);
  const accepted = await acceptBusinessInvitation(
    database.db,
    joiner.userId,
    { code: codeOf(created.link) },
    new Date(),
    ON,
  );
  assert.equal(accepted.kind, 'staff');
  assert.equal((await usage()).staff.used, 2);
});

test('a free business adds no second location; a pro one adds up to 25', async (t) => {
  const { database, business, setPlan, usage } = await setup(t);
  const add = (n) =>
    addLocation(
      database.db,
      ADA.userId,
      business.businessId,
      {
        name: `Branch ${n}`,
        slug: `branch-${n}`,
        address: '1 Test Road, Lagos',
      },
      new Date(),
      ON,
    );
  await refused(add(1), 'BUSINESS_LOCATION_LIMIT');
  await setPlan('pro');
  for (let n = 2; n <= 25; n += 1) await add(n);
  assert.deepEqual((await usage()).locations, { used: 25, limit: 25 });
  await refused(add(26), 'BUSINESS_LOCATION_LIMIT');
});

test("a lapsed business keeps 24 staff and can't add a 25th or a 4th", async (t) => {
  const { database, q, setPlan, invite, member, usage, business } =
    await setup(t);
  await setPlan('pro');
  const team = [];
  for (let n = 0; n < 24; n += 1) team.push(await member());
  await invite(); // the 25th, while pro
  await refused(invite(), 'BUSINESS_STAFF_LIMIT');
  await q(
    `UPDATE business_invitations SET revoked_at = now() WHERE business_id = $1`,
    [business.businessId],
  );
  await setPlan('free');
  assert.deepEqual((await usage()).staff, { used: 24, limit: 3 });
  await refused(invite(), 'BUSINESS_STAFF_LIMIT');
  const open = await q(
    `SELECT count(*)::int AS n FROM business_members bm
       JOIN business_locations l ON l.id = bm.location_id
      WHERE l.business_id = $1 AND bm.left_at IS NULL`,
    [business.businessId],
  );
  assert.equal(open[0].n, 24);
  // People leave: a seat comes back only once below the limit.
  for (const someone of team.slice(0, 21))
    await leaveMember(database, someone.memberId);
  await refused(invite(), 'BUSINESS_STAFF_LIMIT'); // 3 of 3
  await leaveMember(database, team[21].memberId);
  await invite(); // 2 + 1
  await refused(invite(), 'BUSINESS_STAFF_LIMIT');
});

test('limits hold under two invitations at once', async (t) => {
  const { database, business, invite, member } = await setup(t);
  await seedManager(database, {
    businessId: business.businessId,
    userId: TOBI.userId,
  });
  await member();
  await member();
  const results = await Promise.allSettled([
    invite(ADA.userId),
    invite(TOBI.userId),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const lost = results.find((r) => r.status === 'rejected');
  assert.equal(lost.reason.code, 'BUSINESS_STAFF_LIMIT');
});

test('without enforceLimits nothing changes (flag off)', async (t) => {
  const { database, business, invite, member } = await setup(t);
  await member();
  await member();
  await member();
  await invite(ADA.userId, {});
  await invite(ADA.userId, { enforceLimits: false });
  await addLocation(database.db, ADA.userId, business.businessId, {
    name: 'Ikoyi',
    slug: 'ikoyi',
    address: '5 Bourdillon, Lagos',
  });
});
