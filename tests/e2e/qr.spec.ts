import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { makePagePro } from './ops-helpers';
import { WEB_ORIGIN } from './stack';

const WEB_HOST = new URL(WEB_ORIGIN).host;

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
  await expect(page.getByText(`${WEB_HOST}/@${handle}`).first()).toBeVisible();
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
  // The link is printed once, inside the card (QrPrint board), so it is named by the picture.
  await expect(
    page.getByRole('img', { name: `QR code for ${WEB_HOST}/@${handle}` }),
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
  // Upgrade leads to the Pro explanation, with the price the server sends.
  await page.getByRole('link', { name: 'Upgrade to use this design' }).click();
  await page.waitForURL(/\/dashboard\/settings#pro$/);
  await expect(page.getByRole('heading', { name: 'TipMe Pro' })).toBeVisible();
  await expect(page.getByText('Three changes to your handle')).toBeVisible();
  await expect(page.locator('#pro')).toContainText('₦2,500 a month');
  await page.goBack();
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  // A screenshot of it leads to the TipMe home page, never to the person's page.
  await expect.poll(() => scan(image)).toBe(`${WEB_ORIGIN}/?src=qr-preview`);
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
    .toBe(`http://${WEB_HOST}/@${handle}?src=qr`);
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
      .toBe(`http://${WEB_HOST}/@${handle}?src=qr`);
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

test('the code sits on a raised paper panel, and the free card still scans', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/qr');
  const panel = page.locator('.qr-studio .qr-studio__panel');
  await expect(panel).toHaveClass(/tm-surface--paper/);
  const card = panel.locator('canvas.qr-preview');
  await expect(card).toBeVisible();
  // The lettering changed, the code did not: a phone still reads the page link.
  await expect
    .poll(() => scan(card))
    .toBe(`http://${WEB_HOST}/@${handle}?src=qr`);
  // The card's lettering font is not asserted here: on Linux CI runners the canvas never got
  // Manrope (it renders it locally), so that check lives in the unit tests (qr-card with and
  // without a font family) until the CI behaviour is understood (progress.md follow-up).
  // A Pro design's plate is on the same panel.
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  await expect(panel.locator('.qr-design__plate')).toBeVisible();
  await expectAccessible(page);
});

test('@mobile on a phone, the Pro design message sits under the Upgrade panel', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/qr');
  await page.getByRole('radio', { name: /Raised keys/ }).check();
  const upgrade = page.getByRole('link', {
    name: 'Upgrade to use this design',
  });
  await upgrade.scrollIntoViewIfNeeded();
  const status = page.locator('.qr-studio [role="status"]');
  await expect(status).toHaveCount(1);
  await expect(status).toHaveText(
    'Raised keys is a Pro design. This is a preview, and printing needs Pro.',
  );
  // Seen from the Upgrade link, without scrolling, and before every list of designs.
  await expect(status).toBeInViewport();
  const statusBox = await status.boundingBox();
  const listBox = await page
    .locator('.qr-studio fieldset')
    .first()
    .boundingBox();
  expect(statusBox!.y).toBeLessThan(listBox!.y);
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
});

test('saving a free style still says "Style saved" in the same live region', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/qr');
  const status = page.locator('.qr-studio [role="status"]');
  await expect(status).toHaveCount(1);
  // Marked once: a remounted region would lose the mark, and screen readers would stop hearing it.
  await status.evaluate((el) => el.setAttribute('data-test-region', 'kept'));
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  await expect(status).toContainText('Heart modules is a Pro design');
  await page.getByRole('button', { name: 'Use a free style instead' }).click();
  await page.getByRole('radio', { name: /Night/ }).check();
  await expect(status).toHaveText('Style saved');
  await expect(status).toHaveAttribute('data-test-region', 'kept');
  await expectAccessible(page);
});

test('the designs list as Patterns (17), Cards (12) and Photo (1); arrows move across groups', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/qr');
  const group = (name: string) =>
    page.getByRole('group', { name, exact: true });
  await expect(group('Patterns').getByRole('radio')).toHaveCount(17);
  await expect(group('Cards').getByRole('radio')).toHaveCount(12);
  await expect(group('Photo').getByRole('radio')).toHaveCount(1);
  await expect(page.getByRole('group', { name: 'Designs' })).toHaveCount(0);
  // One radio group across the lists: the last Pattern's next design is the first Card.
  await group('Patterns')
    .getByRole('radio', { name: /Naira centre/ })
    .check();
  await expect(
    page.getByRole('img', { name: /Preview of the Naira centre/ }),
  ).toBeVisible();
  await page.keyboard.press('ArrowDown');
  const first = group('Cards').getByRole('radio', { name: /Indigo Grid/ });
  await expect(first).toBeChecked();
  await expect(first).toBeFocused();
  await expect(
    page.getByRole('img', { name: /Preview of the Indigo Grid/ }),
  ).toBeVisible();
  await expectAccessible(page);
});

test('the Free card prints its link once, and paper hides the dashboard notices, not the card', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  // An offline page: "Your page is offline" shows on every dashboard page, this one included.
  await page.goto('/dashboard/settings');
  await page.getByRole('button', { name: 'Take my page offline' }).click();
  await expect(page.getByText('Your page is not live')).toBeVisible();
  await page.goto('/dashboard/qr/print');
  const main = page.getByRole('main');
  const card = main.getByRole('img', {
    name: `QR code for ${WEB_HOST}/@${handle}`,
  });
  await expect(card).toBeVisible();
  // The link is drawn inside the card; no second line under it.
  await expect(main.locator('.print-card__label')).toHaveCount(0);
  const attention = main.getByRole('region', { name: 'Needs your attention' });
  await expect(attention.getByText('Your page is offline')).toBeVisible();
  await page.emulateMedia({ media: 'print' });
  await expect(attention).toBeHidden();
  await expect(card).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await expect(attention).toBeVisible();
  await expectAccessible(page);
});

test('a Pro page chooses a format by its paper picture, and small formats print with a cut line', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const { handle } = await signUpRecipient(page, testInfo);
  await makePagePro(browser, handle, testInfo);
  await page.goto('/dashboard/qr');
  await page.getByRole('radio', { name: /Heart modules/ }).check();
  await expect(page.getByText('Style saved')).toBeVisible();
  // Through the page's own link, as a person does (a direct goto can race the studio's refresh).
  await page.getByRole('link', { name: 'Print card' }).click();
  await page.waitForURL(/\/dashboard\/qr\/print$/);
  const formats = page.getByRole('group', { name: 'Format' });
  await expect(formats.getByRole('radio')).toHaveCount(8);
  for (const [id, name, size] of [
    ['counter', 'Counter card', 'Prints on A6'],
    ['poster', 'Poster', 'Prints on A6'],
    ['sticker', 'Round sticker', 'Prints 80 mm across'],
    ['ticket', 'Ticket', 'Prints on A6'],
    ['receipt', 'Receipt slip', 'Prints on A6'],
    ['lock', 'Phone lock screen', 'Prints on A6'],
    ['business', 'Business card', 'Prints 90 × 55 mm'],
    ['hang', 'Hang tag', 'Prints on A6'],
  ]) {
    const label = formats.locator('label', { hasText: name });
    await expect(label).toContainText(size);
    const art = label.locator(`.qr-pick__art[data-format="${id}"]`);
    await expect(art).toHaveAttribute('aria-hidden', 'true');
    await expect(art).toBeVisible();
  }
  await page.getByLabel('Receipt slip').check();
  await expect(
    formats.getByRole('radio', { name: /Receipt slip/ }),
  ).toBeChecked();
  await expect(page.locator('.qr-format__code')).toBeVisible();
  await expectAccessible(page);

  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.qr-format--receipt')).toHaveCSS(
    'outline-style',
    'dashed',
  );
  await page.emulateMedia({ media: 'screen' });
  await page.getByLabel('Phone lock screen').check();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.qr-format--lock')).toHaveCSS(
    'outline-style',
    'dashed',
  );
  await page.emulateMedia({ media: 'screen' });
  await page.getByLabel('Counter card').check();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.qr-format--counter')).toHaveCSS(
    'outline-style',
    'none',
  );
  await context.close();
});
