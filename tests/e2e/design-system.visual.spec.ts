import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/design-system');
  await page.evaluate(() => document.fonts.ready);
});

test('design authority exposes every governed specimen region', async ({
  page,
}) => {
  for (const region of [
    'type-specimen',
    'material-specimen',
    'control-specimen',
    'symbol-specimen',
    'motion-specimen',
    'responsive-specimen',
  ]) {
    await expect(page.getByTestId(region)).toBeVisible();
  }
});

test('design authority is deterministic at desktop', async ({ page }) => {
  await expect(page).toHaveScreenshot('design-system-desktop.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});

test('design authority is deterministic at mobile @mobile', async ({
  page,
}) => {
  await expect(page).toHaveScreenshot('design-system-mobile.png', {
    animations: 'disabled',
    caret: 'hide',
    fullPage: true,
  });
});
