import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { seedBusiness } from './business-fixtures';
import {
  businessOnlyOwner,
  dashboardNav,
  expectNoSignUp,
  pagelessLogin,
  recordNavigations,
} from './business-signup-fixtures';
import { expectAccessible, signInWithEmail } from './helpers';
import { sql } from './ops-helpers';

// Business sign-up, Task D4: the dashboard for a login with a business and no page.
// BUSINESS_SIGNUP_ENABLED is on in the e2e stack (playwright.config.ts).

test.slow();

test('a business-only login opening /dashboard/tips lands on its business', async ({
  page,
}, testInfo) => {
  await businessOnlyOwner(page, testInfo);
  const visited = recordNavigations(page);
  await page.goto('/dashboard/tips');
  await page.waitForURL(/\/dashboard\/business$/);
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { level: 1, name: 'Mama Put Lekki' }),
  ).toBeVisible({ timeout: 20_000 });
  await expectNoSignUp(visited);
  // Personal links are hidden, not greyed.
  await expect(
    dashboardNav(page).getByRole('link', { name: 'Tips' }),
  ).toHaveCount(0);
  await expect(
    dashboardNav(page).getByRole('link', { name: 'Settings' }),
  ).toBeVisible();
  // A bookmarked /dashboard too.
  await page.goto('/dashboard');
  await page.waitForURL(/\/dashboard\/business$/);
  await expectNoSignUp(visited);
  await expectAccessible(page);
});

test('signing in again lands on the business, never /sign-up', async ({
  page,
}, testInfo) => {
  const owner = await businessOnlyOwner(page, testInfo);
  await page.context().clearCookies();
  const visited = recordNavigations(page);
  await signInWithEmail(page, owner.email);
  await page.waitForURL(/\/dashboard\/business$/);
  // Drawn as the business (the dashboard has read the login), still with no /sign-up.
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { level: 1, name: 'Mama Put Lekki' }),
  ).toBeVisible({ timeout: 20_000 });
  await expectNoSignUp(visited);
});

test('Settings has the login’s own sections, and “Turn on your page” leads to a page', async ({
  page,
}, testInfo) => {
  const owner = await businessOnlyOwner(page, testInfo);
  await page.goto('/dashboard/settings');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'Your email' })).toBeVisible({
    timeout: 20_000,
  });
  await expect(main.getByText(owner.email)).toBeVisible();
  await expect(main.getByRole('heading', { name: 'Devices' })).toBeVisible();
  await expect(
    main.getByRole('heading', { name: 'Your own page' }),
  ).toBeVisible();
  await expectAccessible(page);

  await main.getByRole('button', { name: 'Turn on your page' }).click();
  await page.getByLabel('Handle').fill(owner.handle);
  await expect(page.getByText(`@${owner.handle} is available`)).toBeVisible();
  await page.getByRole('button', { name: `Claim @${owner.handle}` }).click();
  await page.waitForURL(/\/dashboard\/welcome$/);
  await page.goto('/dashboard/business');
  await expect(
    dashboardNav(page).getByRole('link', { name: 'Tips' }),
  ).toBeVisible({
    timeout: 20_000,
  });
});

test('the business offers a page of their own, and “Not now” hides it on this device', async ({
  page,
}, testInfo) => {
  await businessOnlyOwner(page, testInfo);
  await page.goto('/dashboard/business');
  const card = page.getByRole('region', { name: 'Want tips yourself?' });
  await expect(card).toBeVisible({ timeout: 20_000 });
  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { level: 1, name: 'Mama Put Lekki' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole('region', { name: 'Want tips yourself?' }),
  ).toHaveCount(0);
});

test('a manager invitation link opened by a login with no page is accepted from Work', async ({
  page,
  browser,
}, testInfo) => {
  // Someone else's business invites a location manager by link.
  const context = await browser.newContext();
  const ownerPage = await context.newPage();
  const owner = await pagelessLogin(ownerPage, {
    ...testInfo,
    workerIndex: testInfo.workerIndex + 5,
  });
  await context.close();
  const business = await seedBusiness({
    owner: owner.userId,
    name: 'Kilishi Corner',
    slug: `kilishi-${randomUUID().slice(0, 8)}`,
  });
  const code = Array.from({ length: 16 }, () =>
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.charAt(Math.floor(Math.random() * 32)),
  ).join('');
  await sql(
    `INSERT INTO business_invitations (id, business_id, location_id, kind, manager_role, target,
       code_sha256, invited_by, expires_at)
     VALUES ($1, $2, $3, 'manager', 'location_manager', 'link',
       encode(sha256(convert_to($4, 'UTF8')), 'hex'), $5, now() + interval '7 days')`,
    [
      randomUUID(),
      business.businessId,
      business.locations[0]!.id,
      code,
      owner.userId,
    ],
  );

  const me = await pagelessLogin(page, testInfo);
  await page.context().clearCookies();
  await page.goto(`/dashboard/work#join=${code}`);
  await page.waitForURL(/\/sign-in/);
  const visited = recordNavigations(page);
  await signInWithEmail(page, me.email, null);
  await page.waitForURL(/\/dashboard\/work/);
  await expect(
    page.getByText(
      'Kilishi Corner · Victoria Island invites you to manage this location.',
    ),
  ).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(
    dashboardNav(page).getByRole('link', { name: 'Business' }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expectNoSignUp(visited);
});
