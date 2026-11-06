import { expect, test, type Page } from '@playwright/test';
import type {
  BusinessDetail,
  MyMembership,
} from '../../packages/contracts/src/business';
import { expectAccessible, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import {
  accountOf,
  payAtBusiness,
  seedBusiness,
  seedMember,
} from './business-fixtures';

// TipMe for businesses, PR B7: what the business sees. The business's detail (B1) and the Work
// list (B3) belong to other lanes, so this spec answers those two reads itself; everything B7
// owns (insights, notes, share amounts) is the real API.

type Seeded = {
  businessId: string;
  slug: string;
  locationId: string;
  memberId: string;
  handle: string;
};

/** The signed-up person owns The Yellow Chilli and works at its VI location; Tobi works there too. */
async function seed(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
) {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({
    owner: userId,
    locations: [{ slug: 'vi', name: 'Victoria Island' }],
  });
  const locationId = business.locations[0]!.id;
  const { memberId } = await seedMember({
    locationId,
    profileId,
    shownName: 'Kemi',
  });
  const [tobi] = await sql<{ id: string }>(
    `SELECT id FROM profiles WHERE handle_lower = 'tobi'`,
  );
  const tobiMember = (
    await seedMember({ locationId, profileId: tobi!.id, shownName: 'Tobi' })
  ).memberId;
  const kemiTips = [];
  for (let i = 0; i < 3; i += 1)
    kemiTips.push(
      await payAtBusiness(page.request, { handle: who.handle, memberId }),
    );
  await payAtBusiness(page.request, { handle: 'tobi', memberId: tobiMember });
  await sql(
    `INSERT INTO business_notes (tip_id, member_id, tags, body) VALUES ($1, $2, '{friendly,extra_mile}', 'Fixed our order in five minutes.')`,
    [kemiTips[0]!.tipId, memberId],
  );
  const seeded = {
    businessId: business.businessId,
    slug: business.slug,
    locationId,
    memberId,
    handle: who.handle,
  };
  await answerOtherLanes(page, seeded);
  return seeded;
}

/** B1's `GET /v1/me/businesses/:id` and B3's `GET /v1/me/work`, answered here. */
async function answerOtherLanes(page: Page, s: Seeded) {
  const detail: BusinessDetail = {
    id: s.businessId,
    slug: s.slug,
    name: 'The Yellow Chilli',
    status: 'verified',
    slugLocked: true,
    contact: { name: 'Funke', email: 'funke@example.com' },
    locations: [
      {
        id: s.locationId,
        slug: 'vi',
        name: 'Victoria Island',
        address: '27 Ademola Adetokunbo, Lagos',
        closed: false,
      },
    ],
    you: { role: 'owner' },
  };
  const membership: MyMembership = {
    memberId: s.memberId,
    business: {
      id: s.businessId,
      name: 'The Yellow Chilli',
      slug: s.slug,
      status: 'verified',
    },
    location: { id: s.locationId, name: 'Victoria Island', slug: 'vi' },
    shownName: 'Kemi',
    showPhoto: true,
    shareAmounts: false,
    onShift: false,
    staffCodePath: `/b/${s.slug}/vi/${s.handle}`,
  };
  const json = (data: unknown) => ({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-credentials': 'true' },
    body: JSON.stringify({ data }),
  });
  await page.route(
    (url) => url.pathname === `/v1/me/businesses/${s.businessId}`,
    async (route) => {
      const origin = route.request().headers()['origin'];
      const response = json(detail);
      await route.fulfill({
        ...response,
        headers: {
          ...response.headers,
          ...(origin ? { 'access-control-allow-origin': origin } : {}),
        },
      });
    },
  );
  await page.route(
    (url) => url.pathname === '/v1/me/work',
    async (route) => {
      const origin = route.request().headers()['origin'];
      const response = json([membership]);
      await route.fulfill({
        ...response,
        headers: {
          ...response.headers,
          ...(origin ? { 'access-control-allow-origin': origin } : {}),
        },
      });
    },
  );
}

test('the owner sees this week in groups of 3, no amounts, and the notes; reporting one hides it', async ({
  page,
}, testInfo) => {
  const s = await seed(page, testInfo);
  await page.goto('/dashboard/business');
  const week = page.getByRole('region', { name: 'This week' });
  await expect(week.getByTestId('insights-total')).toHaveText('4');
  const table = week.getByRole('table', { name: 'Who’s thanked most' });
  await expect(table.getByRole('row', { name: /Kemi/ })).toContainText('3');
  await expect(table.getByRole('row', { name: /Tobi/ })).toContainText(
    'Fewer than 3',
  );
  // Nobody shares amounts: no amount column, no naira anywhere.
  await expect(
    table.getByRole('columnheader', { name: 'Tip amounts' }),
  ).toHaveCount(0);
  await expect(week).not.toContainText('₦');
  await expect(
    week.getByText(
      'Built from tips and notes only. Customers’ names and contact details never reach you.',
      { exact: false },
    ),
  ).toBeVisible();
  // The next week is never past this one.
  await expect(week.getByRole('button', { name: 'Next week' })).toBeDisabled();

  const notes = page.getByRole('region', { name: 'What customers say' });
  await expect(
    notes.getByText('“Fixed our order in five minutes.”'),
  ).toBeVisible();
  await expect(notes).toContainText('Kemi · Friendly, Went the extra mile');
  await expectAccessible(page);

  // B5 owns the report route; answer it here and check the note goes.
  let reported: unknown;
  await page.route(
    (url) =>
      url.pathname.startsWith(`/v1/me/businesses/${s.businessId}/notes/`) &&
      url.pathname.endsWith('/report'),
    async (route) => {
      if (route.request().method() === 'OPTIONS') return route.fallback();
      reported = route.request().postDataJSON();
      const origin = route.request().headers()['origin'];
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-credentials': 'true',
          ...(origin ? { 'access-control-allow-origin': origin } : {}),
        },
      });
    },
  );
  await notes.getByRole('button', { name: /^Report Kemi/ }).click();
  const reasons = notes.getByRole('group', {
    name: 'What’s wrong with this note?',
  });
  await reasons.getByLabel('Spam or advertising').check();
  await expectAccessible(page);
  await notes.getByRole('button', { name: 'Send report' }).click();
  await expect(
    notes.getByText('Reported. TipMe will review it.'),
  ).toBeVisible();
  await expect(notes.getByText('Fixed our order in five minutes.')).toHaveCount(
    0,
  );
  expect(reported).toEqual({ reason: 'spam' });
});

test('a staff member shares their amounts from Work; the business then sees their weekly total only', async ({
  page,
}, testInfo) => {
  await seed(page, testInfo);
  await page.goto('/dashboard/work');
  const toggle = page.getByRole('switch', {
    name: 'Show my tip amounts to The Yellow Chilli',
  });
  await expect(toggle).not.toBeChecked();
  await expect(
    page.getByText(
      'They see your weekly total only, and only in weeks with 3 or more tips. Turn it off any time.',
    ),
  ).toBeVisible();
  await expectAccessible(page);
  await toggle.check();
  await expect(
    page.getByText('The Yellow Chilli can see your weekly total.'),
  ).toBeVisible();
  await expect(toggle).toBeChecked();

  await page.goto('/dashboard/business');
  const table = page
    .getByRole('region', { name: 'This week' })
    .getByRole('table', { name: 'Who’s thanked most' });
  await expect(
    table.getByRole('columnheader', { name: 'Tip amounts' }),
  ).toBeVisible();
  await expect(table.getByRole('row', { name: /Kemi/ })).toContainText(
    /₦[\d,]+/,
  );
  // Tobi doesn't share (and has fewer than 3 tips).
  await expect(table.getByRole('row', { name: /Tobi/ })).toContainText(
    'Not shared',
  );
  await expectAccessible(page);
});
