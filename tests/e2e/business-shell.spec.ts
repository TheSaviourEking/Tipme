import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';

// TipMe for businesses, PR B0: the dashboard's Business and Work shells and the /b/* placeholder.
// The e2e stack runs with BUSINESS_ENABLED=true (playwright.config.ts).

const nav = (page: Page) => page.getByRole('navigation', { name: 'Dashboard' });

test('a person with no business sees neither link', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard');
  await expect(nav(page).getByRole('link', { name: 'Home' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Business' })).toHaveCount(
    0,
  );
  await expect(nav(page).getByRole('link', { name: 'Work' })).toHaveCount(0);
});

test('a seeded owner sees Business; a seeded member sees Work; both pages pass expectAccessible', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  await seedBusiness({
    owner: userId,
    status: 'pending',
    name: 'Kemi’s Kitchen',
  });
  const workplace = await seedBusiness({
    owner: userId,
    name: 'The Yellow Chilli',
  });
  // The owner of the second business also works there.
  await seedMember({
    locationId: workplace.locations[0]!.id,
    profileId,
    shownName: 'Kemi',
  });
  await page.goto('/dashboard');
  const business = nav(page).getByRole('link', { name: 'Business' });
  const work = nav(page).getByRole('link', { name: 'Work' });
  await expect(business).toHaveCount(1);
  await expect(work).toHaveCount(1);
  if (testInfo.project.name !== 'mobile') {
    // Desktop only: neither sits in the phone's four-item bar.
    await business.click();
  } else {
    await expect(business).toBeHidden();
    await page.goto('/dashboard/business');
  }
  await expect(page).toHaveURL(/\/dashboard\/business$/);
  // Two businesses: a picker, and the first by name shows first.
  await expect(
    page.getByRole('heading', { level: 1, name: 'Kemi’s Kitchen' }),
  ).toBeVisible();
  await expect(page.getByTestId('business-status')).toHaveText(
    'Waiting to be verified',
  );
  // PR B1 fills the page from the business's detail: its Details section shows.
  await expect(
    page.getByRole('heading', { level: 2, name: 'Details' }),
  ).toBeVisible();
  await page
    .getByLabel('Business', { exact: true })
    .selectOption({ label: 'The Yellow Chilli' });
  await expect(
    page.getByRole('heading', { level: 1, name: 'The Yellow Chilli' }),
  ).toBeVisible();
  await expect(page.getByTestId('business-status')).toHaveText(
    'Verified business',
  );
  await expectAccessible(page);

  await page.goto('/dashboard/work');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Work' }),
  ).toBeVisible();
  await expect(
    page.getByText('The Yellow Chilli · Victoria Island'),
  ).toBeVisible();
  await expectAccessible(page);
});

test('a person with no workplace sees the empty Work page', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/work');
  await expect(
    page.getByText('You don’t work anywhere on TipMe yet.'),
  ).toBeVisible();
  await expect(
    page.getByText('When a business invites you, it shows here.'),
  ).toBeVisible();
  await expectAccessible(page);
});

test('/b/yellow-chilli/vi for a pending business says it is not taking tips, noindex', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  const pending = await seedBusiness({ owner: userId, status: 'pending' });
  for (const path of [
    `/b/${pending.slug}/vi`,
    `/b/${pending.slug}/vi/${who.handle}`,
  ]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(
      page.getByRole('heading', {
        level: 1,
        name: 'This business isn’t taking tips on TipMe right now.',
      }),
    ).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex/,
    );
    await expectAccessible(page);
  }
});
