// TipMe for businesses: test fixtures every lane seeds with (plan B0 Task 3). Tests only: they write
// rows directly, never through another lane's routes, so the wave-1 PRs never depend on each other.
import { randomUUID } from 'node:crypto';
import { DEMO_PROFILES } from '../../dist/index.js';

const ADA_USER = DEMO_PROFILES[0].userId;
const poolOf = (db) => db.pool ?? db.$client;

/**
 * A business with its locations and its owner. `db` is the test database (`useDatabase`'s or
 * `openTestDatabase`'s object, or a drizzle db). Status `verified` or `suspended` sets the
 * timestamps the database checks require.
 */
export async function seedBusiness(
  db,
  {
    status = 'verified',
    owner = ADA_USER,
    slug = `biz-${randomUUID().slice(0, 8)}`,
    name = 'The Yellow Chilli',
    locations = [{ slug: 'vi' }],
    now = new Date(),
  } = {},
) {
  const pool = poolOf(db);
  const businessId = randomUUID();
  await pool.query(
    `INSERT INTO businesses (id, slug, name, status, contact_name, contact_email, created_by,
       verified_at, verified_by, suspended_at, suspended_reason, created_at)
     VALUES ($1, $2, $3, $4, 'Funke', 'funke@example.com', $5, $6, $7, $8, $9, $10)`,
    [
      businessId,
      slug,
      name,
      status,
      owner,
      status === 'pending' ? null : now,
      status === 'pending' ? null : owner,
      status === 'suspended' ? now : null,
      status === 'suspended' ? 'Test suspension' : null,
      now,
    ],
  );
  const seeded = [];
  for (const location of locations) {
    const id = randomUUID();
    await pool.query(
      `INSERT INTO business_locations (id, business_id, slug, name, address, closed_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        id,
        businessId,
        location.slug,
        location.name ?? location.slug.toUpperCase(),
        location.address ?? '27 Ademola Adetokunbo, Lagos',
        location.closed ? now : null,
      ],
    );
    seeded.push({ id, slug: location.slug });
  }
  await pool.query(
    `INSERT INTO business_managers (id, business_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [randomUUID(), businessId, owner],
  );
  return { businessId, slug, locations: seeded };
}

/** A manager of a business: an owner (no location) or a location manager. */
export async function seedManager(db, { businessId, userId, locationId }) {
  const managerId = randomUUID();
  await poolOf(db).query(
    `INSERT INTO business_managers (id, business_id, user_id, role, location_id) VALUES ($1, $2, $3, $4, $5)`,
    [
      managerId,
      businessId,
      userId,
      locationId ? 'location_manager' : 'owner',
      locationId ?? null,
    ],
  );
  return { managerId };
}

/** A staff member: a TipMe page at a location, optionally on shift now. */
export async function seedMember(
  db,
  {
    locationId,
    profileId,
    shownName = 'Tobi',
    onShift = false,
    now = new Date(),
  },
) {
  const pool = poolOf(db);
  const memberId = randomUUID();
  await pool.query(
    `INSERT INTO business_members (id, location_id, profile_id, shown_name, joined_at) VALUES ($1, $2, $3, $4, $5)`,
    [memberId, locationId, profileId, shownName, now],
  );
  if (onShift)
    await pool.query(
      `INSERT INTO business_shifts (id, member_id, started_at, started_by) VALUES ($1, $2, $3, 'self')`,
      [randomUUID(), memberId, now],
    );
  return { memberId };
}

/** Ends a membership as a person leaving would (left_by 'self' unless said). */
export async function leaveMember(db, memberId, leftBy = 'self') {
  await poolOf(db).query(
    `UPDATE business_members SET left_at = now(), left_by = $2 WHERE id = $1`,
    [memberId, leftBy],
  );
}

/**
 * A paid pretend tip through the running API, made at a business: quote, intent with the member,
 * then the mock checkout. `api` is the API origin (`startStack().api`).
 */
export async function payAtBusiness(
  api,
  { handle, memberId, amountMinor = 200000n },
) {
  const post = async (path, body, headers = {}) => {
    const response = await fetch(`${api}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  const quote = await post('/v1/tip-quotes', {
    handle,
    amountMinor: String(amountMinor),
    currency: 'NGN',
  });
  const intent = await post(
    '/v1/tip-intents',
    {
      quoteId: quote.data.quoteId,
      ...(memberId ? { businessMemberId: memberId } : {}),
    },
    { 'idempotency-key': randomUUID() },
  );
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await post(`/v1/mock-provider/checkout/${reference}`, { outcome: 'succeed' });
  return { tipId: intent.data.tipId, statusToken: intent.data.statusToken };
}
