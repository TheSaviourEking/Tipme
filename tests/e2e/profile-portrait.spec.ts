import { expect, test, type Page } from '@playwright/test';
import { signUpRecipient } from './helpers';

// A page without a photo shows a matted monogram that fills the portrait frame, not a small
// square in its corner.

async function portraitOf(page: Page, handle: string) {
  // A page that just went live may take a moment to leave the public cache.
  await expect(async () => {
    await page.goto(`/@${handle}`);
    await expect(
      page.locator('[data-profile-portrait] [role="img"]'),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  const frame = await page.locator('[data-profile-portrait]').boundingBox();
  const monogram = await page
    .locator('[data-profile-portrait] [role="img"]')
    .boundingBox();
  return { frame, monogram };
}

const fills = async (
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
) => {
  const { handle } = await signUpRecipient(page, testInfo);
  const { frame, monogram } = await portraitOf(page, handle);
  expect(frame && monogram).toBeTruthy();
  expect(Math.abs(monogram!.width - frame!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(monogram!.height - frame!.height)).toBeLessThanOrEqual(2);
};

test('a page without a photo fills its portrait with the monogram', async ({
  page,
}, testInfo) => {
  await fills(page, testInfo);
});

test('a page without a photo fills its portrait with the monogram @mobile', async ({
  page,
}, testInfo) => {
  await fills(page, testInfo);
});
