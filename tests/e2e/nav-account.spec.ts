import { expect, test, type Page } from '@playwright/test';
import { signUpRecipient } from './helpers';
import { accountOf, seedBusiness } from './business-fixtures';

// The owner, 6 Nov 2026: signed in, the header's "Sign in" and "Claim your username" give way to
// "Go to my dashboard", plus "Business" for someone who runs one. Built without a board (owner: "Build it").

const nav = (page: Page) =>
  page.getByRole('navigation', { name: 'Main navigation' });

/** On a phone the header's actions are in the open menu. */
async function openMenu(page: Page, project: string) {
  if (project === 'mobile')
    await page.getByRole('button', { name: 'Open menu' }).click();
}

test('signed in, the header offers the dashboard instead of Sign in and Claim', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/for-creators');
  await openMenu(page, testInfo.project.name);
  const dashboard = nav(page).getByRole('link', { name: 'Go to my dashboard' });
  await expect(dashboard).toBeVisible();
  await expect(dashboard).toHaveAttribute('href', '/dashboard');
  await expect(nav(page).getByRole('link', { name: 'Sign in' })).toHaveCount(0);
  await expect(
    nav(page).getByRole('link', { name: 'Claim your username' }),
  ).toHaveCount(0);
  // No business: no Business link.
  await expect(nav(page).getByRole('link', { name: 'Business' })).toHaveCount(
    0,
  );
  await dashboard.click();
  await page.waitForURL(/\/dashboard$/);
  // On the dashboard itself the link would lead where they already are.
  await expect(
    nav(page).getByRole('link', { name: 'Go to my dashboard' }),
  ).toHaveCount(0);
  await page.goto('/dashboard/settings');
  await openMenu(page, testInfo.project.name);
  await expect(
    nav(page).getByRole('link', { name: 'Go to my dashboard' }),
  ).toBeVisible();
});

test('someone who runs a business also gets a Business link', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  await seedBusiness({ owner: userId, name: 'Kemi’s Kitchen' });
  await page.goto('/');
  await openMenu(page, testInfo.project.name);
  const business = nav(page).getByRole('link', { name: 'Business' });
  await expect(business).toBeVisible();
  await expect(business).toHaveAttribute('href', '/dashboard/business');
});

test('a visitor who never signed in makes no account request and sees Sign in', async ({
  page,
}, testInfo) => {
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/me/')) asked.push(request.url());
  });
  await page.goto('/');
  await openMenu(page, testInfo.project.name);
  await expect(nav(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(
    nav(page).getByRole('link', { name: 'Go to my dashboard' }),
  ).toHaveCount(0);
  expect(asked).toEqual([]);
});

test('an ended session turns the header back to Sign in', async ({
  page,
}, testInfo) => {
  // This browser was signed in once, but has no session now.
  await page.goto('/');
  await page.evaluate(() => localStorage.setItem('tipme:signed-in', '1'));
  await page.goto('/for-creators');
  await openMenu(page, testInfo.project.name);
  await expect(nav(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(
    nav(page).getByRole('link', { name: 'Go to my dashboard' }),
  ).toHaveCount(0);
});

test('signing out puts Sign in back', async ({ page }, testInfo) => {
  test.skip(
    testInfo.project.name === 'mobile',
    'Sign out sits in the dashboard menu on a phone; the hint is the same.',
  );
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.waitForURL(/\/sign-in/);
  await page.goto('/');
  await expect(nav(page).getByRole('link', { name: 'Sign in' })).toBeVisible();
  await expect(
    nav(page).getByRole('link', { name: 'Go to my dashboard' }),
  ).toHaveCount(0);
});
