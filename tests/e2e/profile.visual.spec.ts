import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/@ada');
  await page.evaluate(() => document.fonts.ready);
});

// Concept A (docs/design/reference): the identity card overlaps the portrait's lower left and
// the tipping panel floats over its right edge, beside a headline on the left.
test('public profile has the portrait-led overlapping composition', async ({
  page,
}) => {
  const box = async (selector: string) => {
    // boundingBox() does not wait for visibility; measure only rendered elements.
    await expect(page.locator(selector)).toBeVisible();
    const found = await page.locator(selector).boundingBox();
    if (!found) throw new Error(`${selector} is not rendered`);
    return found;
  };
  const portrait = await box('[data-profile-portrait]');
  const card = await box('[data-profile-card]');
  const panel = await box('[data-tip-panel]');
  const headline = await box('.profile-headline__title');

  expect(headline.x + headline.width).toBeLessThanOrEqual(portrait.x + 1);
  expect(card.x).toBeLessThan(portrait.x);
  expect(card.x + card.width).toBeGreaterThan(portrait.x + 32);
  expect(card.y + card.height / 2).toBeGreaterThan(
    portrait.y + portrait.height / 2,
  );
  expect(panel.x).toBeLessThan(portrait.x + portrait.width - 32);
  expect(panel.x + panel.width).toBeGreaterThan(portrait.x + portrait.width);
  // A compact instrument, not a full-width checkout column.
  expect(panel.width).toBeLessThan(portrait.width);
});

test('public profile portrait falls back to initials when loading fails', async ({
  page,
}) => {
  await page.route('**/_next/image**', (route) => route.abort());
  await page.reload();
  await expect(
    page.locator('[data-profile-portrait]').getByText('AO', { exact: true }),
  ).toBeVisible();
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
