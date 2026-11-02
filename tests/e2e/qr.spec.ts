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
  // A picture being swapped in is retried by the caller's poll, not a failure.
  const shot = await element.screenshot().catch(() => null);
  if (!shot) return undefined;
  const { data, info } = await sharp(shot)
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
  // Upgrade leads to the Pro explanation, with no price and no billing.
  await page.getByRole('link', { name: 'Upgrade to use this design' }).click();
  await page.waitForURL(/\/dashboard\/settings#pro$/);
  await expect(page.getByRole('heading', { name: 'TipMe Pro' })).toBeVisible();
  await expect(page.getByText('Three changes to your handle')).toBeVisible();
  await expect(page.locator('#pro')).not.toContainText(/₦|NGN|\$|per month/);
  await page.goBack();
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  // A screenshot of it leads to the TipMe home page, never to the person's page.
  await expect
    .poll(() => scan(image))
    .toBe('http://127.0.0.1:3100/?src=qr-preview');
  // Nothing was saved: a reload is back on the free style.
  await page.reload();
  await expect(page.getByRole('radio', { name: /Purple/ })).toBeChecked();
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  // Said where a screen reader is already listening, not only drawn on screen.
  await expect(page.locator('p.settings-saved[role="status"]')).toContainText(
    'Heart modules is a Pro design. This is a preview, and printing needs Pro.',
  );
  await page.getByRole('button', { name: 'Use a free style instead' }).click();
  // Focus is never lost: it moves to the style in use.
  await expect(page.getByRole('radio', { name: /Purple/ })).toBeFocused();
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
  // The sheet itself never animates, on screen or on paper.
  await page.emulateMedia({ media: 'print' });
  expect(
    await page
      .locator('.qr-format, .qr-format__code')
      .evaluateAll((all) =>
        all.map((el) => getComputedStyle(el).animationName),
      ),
  ).toEqual(['none', 'none']);
  await page.emulateMedia({ media: 'screen', reducedMotion: 'reduce' });
  expect(
    await page
      .locator('.qr-format__code')
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe('none');
  await context.close();
});

test('@mobile the studio, a locked preview and the print formats fit a phone', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext({
    viewport: { width: 360, height: 800 },
  });
  const page = await context.newPage();
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/qr');
  await expect(page.getByRole('heading', { name: 'My QR code' })).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  await expect(
    page.getByRole('link', { name: 'Upgrade to use this design' }),
  ).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
  await makePagePro(browser, handle, testInfo);
  await page.goto('/dashboard/qr');
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  await expect(page.getByText('Style saved')).toBeVisible();
  await page.goto('/dashboard/qr/print');
  for (const format of ['Business card', 'Round sticker', 'Poster']) {
    await page.getByRole('radio', { name: new RegExp(format) }).check();
    await expect(page.locator('.qr-format__code')).toBeVisible();
    expect(await fitsViewport(page)).toBe(true);
  }
  await context.close();
});

test('Show full screen waits for a Pro design to be drawn, and stays off if it fails', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { handle } = await signUpRecipient(page, testInfo);
  await makePagePro(browser, handle, testInfo);
  await page.goto('/dashboard/qr');
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  await expect(page.getByText('Style saved')).toBeVisible();
  const fullScreen = page.getByRole('button', { name: 'Show full screen' });
  await expect(fullScreen).toBeEnabled();

  // The full-size picture is held back, then refused: a blank screen must never be offered.
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route(/\/v1\/me\/qr-art\/[^/]+\.png\?size=/, async (route) => {
    await held;
    await route.fulfill({ status: 500, body: '{}' });
  });
  await page.getByRole('radio', { name: /Jewel/ }).check();
  await expect(fullScreen).toBeDisabled();
  release();
  await expect(page.locator('.qr-design__error')).toBeVisible();
  await expect(fullScreen).toBeDisabled();
  await context.close();
});
