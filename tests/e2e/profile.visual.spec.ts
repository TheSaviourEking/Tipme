import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/@ada');
  await page.evaluate(() => document.fonts.ready);
});

test('public profile has the governed paired-object composition', async ({
  page,
}) => {
  await expect(page.locator('[data-profile-card]')).toBeVisible();
  await expect(page.locator('[data-tip-panel]')).toBeVisible();
  await expect(page.locator('.profile-grid')).toHaveCSS(
    'grid-template-columns',
    /.+ .+/,
  );
});

test('public profile portrait falls back to initials when loading fails', async ({
  page,
}) => {
  await page.route('**/_next/image**', (route) => route.abort());
  await page.reload();
  await expect(page.getByText('AO', { exact: true })).toBeVisible();
});

test('public profile visual desktop', async ({ page }) => {
  await expect(page).toHaveScreenshot('profile-desktop.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('public profile visual mobile @mobile', async ({ page }) => {
  await expect(page).toHaveScreenshot('profile-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});
