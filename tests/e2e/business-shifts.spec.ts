import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';
import { sql } from './ops-helpers';

// TipMe for businesses, PR B6: check in and out on the Work page, and a manager's "On today"
// switches on the Business page. The checks in and out go to the real API and land in the
// database, and the reads other lanes own (B3's `GET /v1/me/work` and members list, B1's business
// detail) are the real API too.

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

async function seed(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
): Promise<Seeded> {
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
