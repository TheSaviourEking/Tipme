import { expect, test } from '@playwright/test';
import { expectAccessible, identity, signInWithEmail } from './helpers';
import { enrolOwner, grantOwner, withDatabase } from './ops-helpers';

const enrolStep = (page: import('@playwright/test').Page) =>
  page.getByRole('heading', { name: 'Set up your authenticator' });

test('someone invited can open the decline confirmation, cancel it, and decline', async ({
  page,
}, testInfo) => {
  const { email } = identity(testInfo);
  await grantOwner(email);
  await signInWithEmail(page, email, '/sign-in?next=/ops');
  await page.waitForURL(/\/ops$/);
  await expect(enrolStep(page)).toBeVisible();

  const open = page.getByRole('button', { name: 'Decline admin access' });
  await open.click();
  const confirmation = page.getByRole('group', {
    name: 'Decline admin access?',
  });
  await expect(confirmation).toBeFocused();
  // Nothing about it is a live region: a screen reader is taken there by focus.
  await expect(confirmation.locator('[role=status]')).toHaveCount(0);
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(open).toBeFocused();

  await open.click();
  await page.getByRole('button', { name: 'Yes, decline' }).click();
  await page.waitForURL(/\/dashboard|\/sign-up|\/onboarding|\/$/);
  await page.goto('/ops');
  await expect(enrolStep(page)).toHaveCount(0);
});

test('the admin sign-in card sits in the middle of the page, under the staff banner', async ({
  page,
}, testInfo) => {
  const { email } = identity(testInfo);
  await grantOwner(email);
  await signInWithEmail(page, email, '/sign-in?next=/ops');
  await page.waitForURL(/\/ops$/);
  await expect(enrolStep(page)).toBeVisible();
  const card = await page.locator('.ops-step').boundingBox();
  const banner = await page.locator('.ops-banner').boundingBox();
  if (!card || !banner) throw new Error('the card or the banner is missing');
  // Narrower than the banner, and centred under it (within 2px).
  expect(card.width).toBeLessThan(banner.width);
  expect(
    Math.abs(card.x + card.width / 2 - (banner.x + banner.width / 2)),
  ).toBeLessThanOrEqual(2);
});

test('a decline the server refuses says so plainly', async ({
  page,
}, testInfo) => {
  const { email } = identity(testInfo);
  await grantOwner(email);
  await signInWithEmail(page, email, '/sign-in?next=/ops');
  await expect(enrolStep(page)).toBeVisible();
  await page.route('**/v1/ops/decline', (route) =>
    route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'STAFF_ALREADY_ENROLLED', message: 'x' },
      }),
    }),
  );
  await page.getByRole('button', { name: 'Decline admin access' }).click();
  await page.getByRole('button', { name: 'Yes, decline' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Contact the owner' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Decline admin access' }),
  ).toHaveCount(0);
});

test('someone re-enrolling after losing their phone is not offered Decline', async ({
  page,
}, testInfo) => {
  const { email } = await enrolOwner(page, testInfo);
  await withDatabase((db, ops) => ops.grantOwner(db, { email }));
  await page.goto('/ops');
  await expect(enrolStep(page)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Decline admin access' }),
  ).toHaveCount(0);
});

test('a passing failure shows a retry that reports progress and keeps the emailed link', async ({
  page,
}, testInfo) => {
  const { email } = identity(testInfo);
  await grantOwner(email);
  await signInWithEmail(page, email, '/sign-in?next=/ops');
  await expect(enrolStep(page)).toBeVisible();

  await page.route('**/v1/ops/me', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ status: 503, body: '{}' });
  });
  // Away first: from /ops, only the fragment would change, and nothing would load.
  await page.goto('about:blank');
  await page.goto('/ops#enrol=ABCDEFGH23');
  const retry = page.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'couldn’t load' }),
  ).toBeVisible();
  await expectAccessible(page);
  await retry.click();
  await expect(retry).toHaveAttribute('aria-busy', 'true');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Still not loading' }),
  ).toBeVisible();
  await expect(retry).not.toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => location.hash)).toBe('#enrol=ABCDEFGH23');

  await page.unroute('**/v1/ops/me');
  await retry.click();
  await expect(enrolStep(page)).toBeVisible();
  await expect(page.locator('main')).toBeFocused();
  await expect(page.getByLabel('Enrolment code')).toHaveValue('ABCDEFGH23');
  expect(await page.evaluate(() => location.hash)).toBe('');
});
