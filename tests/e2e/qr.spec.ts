import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';

test('a recipient styles their QR code, then prints, shows and shares it', async ({
  page,
}, testInfo) => {
  // No Web Share here, so sharing falls back to downloading the image.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(navigator, 'canShare', {
      value: undefined,
      configurable: true,
    });
  });
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/qr');
  await expect(page.getByRole('heading', { name: 'My QR code' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /Purple/ })).toBeChecked();
  await expect(
    page.getByText('Premium · free in preview').first(),
  ).toBeVisible();
  await expect(
    page.getByText(`127.0.0.1:3100/@${handle}`).first(),
  ).toBeVisible();
  await page.getByRole('radio', { name: /Night/ }).check();
  await expect(page.getByText('Style saved')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('radio', { name: /Night/ })).toBeChecked();
  await expectAccessible(page);

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Share image' }).click();
  expect((await download).suggestedFilename()).toBe(`tipme-${handle}.png`);

  await page.getByRole('button', { name: 'Show full screen' }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement !== null))
    .toBe(true);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === null))
    .toBe(true);

  await page.getByRole('link', { name: 'Print card' }).click();
  await page.waitForURL(/\/dashboard\/qr\/print$/);
  await expect(
    page.getByText(`127.0.0.1:3100/@${handle}`).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('img', { name: `QR code for 127.0.0.1:3100/@${handle}` }),
  ).toBeVisible();
  await expectAccessible(page);

  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto('/dashboard/qr');
  await expect(page.getByRole('heading', { name: 'My QR code' })).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
});
