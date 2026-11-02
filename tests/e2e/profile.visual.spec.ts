import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/@ada');
  await page.evaluate(() => document.fonts.ready);
});

// The cover leads; the photo overlaps its lower edge and the tipping panel its lower right.
test('public profile has the cover-led overlapping composition', async ({
  page,
}) => {
  const box = async (selector: string) => {
    // boundingBox() does not wait for visibility; measure only rendered elements.
    await expect(page.locator(selector)).toBeVisible();
    const found = await page.locator(selector).boundingBox();
    if (!found) throw new Error(`${selector} is not rendered`);
    return found;
  };
  const cover = await box('[data-profile-cover]');
  const photo = await box('.profile-photo');
  const panel = await box('[data-tip-panel]');
  const bottom = cover.y + cover.height;

  expect(photo.y).toBeLessThan(bottom);
  expect(photo.y + photo.height).toBeGreaterThan(bottom);
  expect(photo.x).toBeLessThan(cover.x + cover.width / 2);
  expect(panel.y).toBeLessThan(bottom);
  expect(panel.x).toBeGreaterThan(cover.x + cover.width / 2);
  expect(panel.x + panel.width).toBeLessThanOrEqual(cover.x + cover.width + 1);
});

test('public profile photo falls back to initials when loading fails', async ({
  page,
}) => {
  await page.route('**/_next/image**', (route) => route.abort());
  await page.reload();
  await page.getByRole('heading', { level: 1 }).waitFor();
  await expect(page.locator('.profile-photo')).toHaveText('AO');
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
