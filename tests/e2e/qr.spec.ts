import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { makePagePro } from './ops-helpers';

// sharp and jsQR are other packages' dependencies (resolved from there); only what is used is typed.
type Decode = (
  data: Uint8ClampedArray,
  w: number,
  h: number,
) => { data: string } | null;
const jsQR = createRequire(resolve('apps/web/package.json'))('jsqr') as Decode;
const sharp = createRequire(resolve('apps/api/package.json'))('sharp') as (
  input: Buffer,
) => {
  ensureAlpha(): {
    raw(): {
      toBuffer(o: { resolveWithObject: true }): Promise<{
        data: Buffer;
        info: { width: number; height: number };
      }>;
    };
  };
};

/** What a phone would read from a screenshot of this element. */
async function scan(element: Locator): Promise<string | undefined> {
  const { data, info } = await sharp(await element.screenshot())
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}

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
  await expect(page.getByText(/Premium|free in preview/)).toHaveCount(0);
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

test('a Free page previews a Pro design with its mark, and cannot print, share or show it', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/qr');
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  const image = page.getByRole('img', { name: /Preview of the Heart modules/ });
  await expect(image).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Upgrade to use this design' }),
  ).toBeVisible();
  for (const name of ['Show full screen', 'Share image', 'Download image'])
    await expect(page.getByRole('button', { name })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Print card' })).toHaveCount(0);
  // A screenshot of it leads to the TipMe home page, never to the person's page.
  await expect
    .poll(() => scan(image))
    .toBe('http://127.0.0.1:3100/?src=qr-preview');
  // Nothing was saved: a reload is back on the free style.
  await page.reload();
  await expect(page.getByRole('radio', { name: /Purple/ })).toBeChecked();
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  await page.getByRole('button', { name: 'Use a free style instead' }).click();
  await expect(page.getByRole('button', { name: 'Share image' })).toBeVisible();
  await page.getByRole('link', { name: 'Print card' }).click();
  await page.waitForURL(/\/dashboard\/qr\/print$/);
  await expect(page.getByRole('radio', { name: 'Counter card' })).toHaveCount(
    0,
  );
});

test('a Pro page saves a design, prints it in each format, and its printed code scans', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({ deviceScaleFactor: 3 });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1000, height: 1400 });
  const { handle } = await signUpRecipient(page, testInfo);
  await makePagePro(browser, handle, testInfo);
  await page.goto('/dashboard/qr');
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  await expect(page.getByText('Style saved')).toBeVisible();
  const image = page.getByRole('img', { name: /Heart modules design/ });
  await expect(image).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Upgrade to use this design' }),
  ).toHaveCount(0);
  await expect
    .poll(() => scan(image))
    .toBe(`http://127.0.0.1:3100/@${handle}?src=qr`);
  await page.reload();
  await expect(
    page.getByRole('radio', { name: /Heart modules/ }),
  ).toBeChecked();

  await page.getByRole('link', { name: 'Print card' }).click();
  await page.waitForURL(/\/dashboard\/qr\/print$/);
  for (const format of [
    'Counter card',
    'Poster',
    'Round sticker',
    'Ticket',
    'Receipt slip',
    'Phone lock screen',
    'Business card',
    'Hang tag',
  ]) {
    await page.getByRole('radio', { name: format }).check();
    const code = page.locator('.qr-format__code');
    await expect(code).toBeVisible();
    await expect
      .poll(() => scan(code), { message: format })
      .toBe(`http://127.0.0.1:3100/@${handle}?src=qr`);
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.qr-format__code')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await context.close();
});
