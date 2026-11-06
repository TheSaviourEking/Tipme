import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { sql } from './ops-helpers';
import { API_ORIGIN } from './stack';

// TipMe for businesses: e2e fixtures every lane seeds with (plan B0 Task 3). They write rows
// directly, never through another lane's routes, so the wave-1 PRs never depend on each other.

/** The account and page behind a signed-up test person's email. */
export async function accountOf(
  email: string,
): Promise<{ userId: string; profileId: string }> {
  const [row] = await sql<{ user_id: string; profile_id: string }>(
    `SELECT u.id AS user_id, p.id AS profile_id
       FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE lower(u.email) = lower($1)`,
    [email],
  );
  if (!row) throw new Error(`no account for ${email}`);
  return { userId: row.user_id, profileId: row.profile_id };
}

/** A business with its locations and its owner; `slug` defaults to a fresh one. */
export async function seedBusiness({
  owner,
  status = 'verified',
  slug = `biz-${randomUUID().slice(0, 8)}`,
  name = 'The Yellow Chilli',
  locations = [{ slug: 'vi', name: 'Victoria Island' }],
}: {
  owner: string;
  status?: 'pending' | 'verified' | 'suspended';
  slug?: string;
  name?: string;
  locations?: { slug: string; name?: string; closed?: boolean }[];
}): Promise<{
  businessId: string;
  slug: string;
  locations: { id: string; slug: string }[];
}> {
  const businessId = randomUUID();
  const decided = status !== 'pending';
  await sql(
    `INSERT INTO businesses (id, slug, name, status, contact_name, contact_email, created_by,
       verified_at, verified_by, suspended_at, suspended_reason)
     VALUES ($1, $2, $3, $4, 'Funke', 'funke@example.com', $5,
       CASE WHEN $6 THEN now() END, CASE WHEN $6 THEN $5::uuid END,
       CASE WHEN $4 = 'suspended' THEN now() END,
       CASE WHEN $4 = 'suspended' THEN 'Test suspension' END)`,
    [businessId, slug, name, status, owner, decided],
  );
  const seeded = [];
  for (const location of locations) {
    const id = randomUUID();
    await sql(
      `INSERT INTO business_locations (id, business_id, slug, name, address, closed_at)
       VALUES ($1, $2, $3, $4, '27 Ademola Adetokunbo, Lagos', CASE WHEN $5 THEN now() END)`,
      [
        id,
        businessId,
        location.slug,
        location.name ?? location.slug.toUpperCase(),
        Boolean(location.closed),
      ],
    );
    seeded.push({ id, slug: location.slug });
  }
  await sql(
    `INSERT INTO business_managers (id, business_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
    [randomUUID(), businessId, owner],
  );
  return { businessId, slug, locations: seeded };
}

/** A staff member: a TipMe page at a location, optionally on shift now. */
export async function seedMember({
  locationId,
  profileId,
  shownName = 'Tobi',
  onShift = false,
}: {
  locationId: string;
  profileId: string;
  shownName?: string;
  onShift?: boolean;
}): Promise<{ memberId: string }> {
  const memberId = randomUUID();
  await sql(
    `INSERT INTO business_members (id, location_id, profile_id, shown_name, joined_at) VALUES ($1, $2, $3, $4, now())`,
    [memberId, locationId, profileId, shownName],
  );
  if (onShift)
    await sql(
      `INSERT INTO business_shifts (id, member_id, started_at, started_by) VALUES ($1, $2, now(), 'self')`,
      [randomUUID(), memberId],
    );
  return { memberId };
}

/** A paid pretend tip made at a business through the API: quote, intent with the member, mock pay. */
export async function payAtBusiness(
  request: APIRequestContext,
  {
    handle,
    memberId,
    amountMinor = '200000',
  }: { handle: string; memberId?: string; amountMinor?: string },
): Promise<{ tipId: string; statusToken: string }> {
  const quote = await (
    await request.post(`${API_ORIGIN}/v1/tip-quotes`, {
      data: { handle, amountMinor, currency: 'NGN' },
    })
  ).json();
  const intent = await (
    await request.post(`${API_ORIGIN}/v1/tip-intents`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        quoteId: quote.data.quoteId,
        ...(memberId ? { businessMemberId: memberId } : {}),
      },
    })
  ).json();
  const reference = String(intent.data.checkoutUrl).split('/mock-checkout/')[1];
  await request.post(`${API_ORIGIN}/v1/mock-provider/checkout/${reference}`, {
    data: { outcome: 'succeed' },
  });
  return { tipId: intent.data.tipId, statusToken: intent.data.statusToken };
}
