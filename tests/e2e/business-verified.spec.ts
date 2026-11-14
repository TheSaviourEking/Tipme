import { expect, test } from '@playwright/test';
import { businessOnlyOwner, verifyAsStaff } from './business-signup-fixtures';
import { expectAccessible } from './helpers';

// Business sign-up, Task D5: what happens next while waiting, and the once-only verified moment.
// BUSINESS_SIGNUP_ENABLED is on in the e2e stack (playwright.config.ts).

test.slow();

test('waiting shows what happens next; after TipMe verifies, the first visit celebrates once', async ({
  page,
}, testInfo) => {
  const owner = await businessOnlyOwner(page, testInfo, { status: 'pending' });
  await page.goto(`/dashboard/business?business=${owner.businessId}`);
  const main = page.getByRole('main');
  await expect(
    main.getByText('Waiting for TipMe to check your business.'),
  ).toBeVisible({ timeout: 20_000 });
  const next = main.getByRole('list', { name: 'What happens next' });
  await expect(next.getByRole('listitem')).toHaveCount(4);
  await expect(next).toContainText('Sent to TipMe');
  await expect(next).toContainText('Print one for Admiralty Way.');
  await expect(
    main.getByText(`We’ll email you at ${owner.email}`),
  ).toBeVisible();
  await expect(
    main.getByText('You can add your logo and invite staff now.'),
  ).toBeVisible();
  await expectAccessible(page);

  await verifyAsStaff(owner.businessId);
  await page.reload();
  const moment = main.getByRole('region', { name: 'Verified by TipMe' });
  await expect(moment).toBeVisible({ timeout: 20_000 });
  await expect(moment.getByText('Mama Put Lekki is live.')).toBeVisible();
  await expect(
    moment.getByRole('link', { name: 'Print your Admiralty Way code' }),
  ).toBeVisible();
  await expectAccessible(page);

  // Once: a reload doesn't show it again.
  await page.reload();
  await expect(
    main.getByRole('heading', { level: 1, name: 'Mama Put Lekki' }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    main.getByRole('region', { name: 'Verified by TipMe' }),
  ).toHaveCount(0);
});

test('with reduced motion the moment has no animation, and the same words', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const owner = await businessOnlyOwner(page, testInfo, { status: 'pending' });
  await verifyAsStaff(owner.businessId);
  await page.goto(`/dashboard/business?business=${owner.businessId}`);
  const moment = page
    .getByRole('main')
    .getByRole('region', { name: 'Verified by TipMe' });
  await expect(moment.getByText('Mama Put Lekki is live.')).toBeVisible({
    timeout: 20_000,
  });
  const names = await moment
    .locator('*')
    .evaluateAll((nodes) =>
      nodes.map((node) => getComputedStyle(node).animationName),
    );
  expect(names.filter((name) => name !== 'none')).toEqual([]);
});
