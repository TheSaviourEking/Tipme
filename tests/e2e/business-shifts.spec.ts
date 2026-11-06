import { expect, test, type Page, type Route } from '@playwright/test';
import type {
  BusinessDetail,
  MemberRow,
  MyMembership,
} from '../../packages/contracts/src/business';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';
import { sql } from './ops-helpers';

// TipMe for businesses, PR B6: check in and out on the Work page, and a manager's "On today"
// switches on the Business page. The checks in and out go to the real API and land in the
// database. The reads that other lanes own (B3's `GET /v1/me/work` and members list, B1's business
// detail) are answered here from the same database rows until those lanes are on this branch.

type Seeded = {
  businessId: string;
  slug: string;
  memberId: string;
  locationId: string;
  handle: string;
};

async function openShift(memberId: string) {
  const [row] = await sql<{ started_at: Date; started_by: string }>(
    `SELECT started_at, started_by FROM business_shifts WHERE member_id = $1 AND ended_at IS NULL`,
    [memberId],
  );
  return row ?? null;
}

// A credentialed cross-origin read: the answer names the web origin, as the API's CORS does.
const json = (route: Route, data: unknown) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': route.request().headers()['origin'] ?? '',
      'access-control-allow-credentials': 'true',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({ data }),
  });

/** B3's `GET /v1/me/work`, from the database: the shift state is the server's. */
async function answerWork(page: Page, seeded: Seeded) {
  await page.route(
    (url) => url.pathname === '/v1/me/work',
    async (route) => {
      const open = await openShift(seeded.memberId);
      const membership: MyMembership = {
        memberId: seeded.memberId,
        business: {
          id: seeded.businessId,
          name: 'The Yellow Chilli',
          slug: seeded.slug,
          status: 'verified',
        },
        location: {
          id: seeded.locationId,
          name: 'Victoria Island',
          slug: 'vi',
        },
        shownName: 'Tobi',
        showPhoto: true,
        shareAmounts: false,
        onShift: Boolean(open),
        ...(open ? { shiftStartedAt: open.started_at.toISOString() } : {}),
        staffCodePath: `/b/${seeded.slug}/vi/${seeded.handle}`,
      };
      await json(route, [membership]);
    },
  );
}

/** B1's business detail and B3's members list, from the database. */
async function answerBusiness(page: Page, seeded: Seeded) {
  await page.route(
    (url) => url.pathname === `/v1/me/businesses/${seeded.businessId}`,
    (route) => {
      const detail: BusinessDetail = {
        id: seeded.businessId,
        slug: seeded.slug,
        name: 'The Yellow Chilli',
        status: 'verified',
        slugLocked: true,
        contact: { name: 'Funke', email: 'funke@example.com' },
        locations: [
          {
            id: seeded.locationId,
            slug: 'vi',
            name: 'Victoria Island',
            address: '27 Ademola Adetokunbo, Lagos',
            closed: false,
          },
        ],
        you: { role: 'owner' },
      };
      return json(route, detail);
    },
  );
  await page.route(
    (url) => url.pathname === `/v1/me/businesses/${seeded.businessId}/members`,
    async (route) => {
      const open = await openShift(seeded.memberId);
      const row: MemberRow = {
        memberId: seeded.memberId,
        profileHandle: seeded.handle,
        shownName: 'Tobi',
        showPhoto: true,
        onShift: Boolean(open),
        joinedAt: new Date().toISOString(),
        locationId: seeded.locationId,
      };
      await json(route, [row]);
    },
  );
}

async function seed(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
) {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({ owner: userId });
  const locationId = business.locations[0]!.id;
  const { memberId } = await seedMember({ locationId, profileId });
  return {
    businessId: business.businessId,
    slug: business.slug,
    memberId,
    locationId,
    handle: who.handle,
  };
}

test('a person checks in on the Work page and checks out again', async ({
  page,
}, testInfo) => {
  const seeded = await seed(page, testInfo);
  await answerWork(page, seeded);
  await page.goto('/dashboard/work');
  const card = page.getByTestId('work-shift');
  await expect(card.getByText('You’re not on shift.')).toBeVisible();
  await expectAccessible(page);

  await card
    .getByRole('button', { name: 'Check in at Victoria Island' })
    .click();
  await expect(
    card.getByText(/^You’re on at Victoria Island since \d{2}:\d{2}\.$/),
  ).toBeVisible();
  const open = await openShift(seeded.memberId);
  expect(open?.started_by).toBe('self');

  // The page reads it back from the server after a reload.
  await page.reload();
  await expect(
    card.getByText(/^You’re on at Victoria Island since \d{2}:\d{2}\.$/),
  ).toBeVisible();
  await expectAccessible(page);
  await card.getByRole('button', { name: 'Check out' }).click();
  await expect(card.getByText('You’re not on shift.')).toBeVisible();
  expect(await openShift(seeded.memberId)).toBeNull();
});

test('a manager checks someone in and out with the On today switch', async ({
  page,
}, testInfo) => {
  const seeded = await seed(page, testInfo);
  await answerBusiness(page, seeded);
  await page.goto('/dashboard/business');
  const list = page.getByTestId('on-today');
  const toggle = list.getByRole('switch', { name: 'Tobi On today' });
  await expect(toggle).not.toBeChecked();
  await expectAccessible(page);

  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect
    .poll(async () => (await openShift(seeded.memberId))?.started_by)
    .toBe('manager');

  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => openShift(seeded.memberId)).toBeNull();
});
