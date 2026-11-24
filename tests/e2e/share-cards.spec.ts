import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { makePagePro } from './ops-helpers';
import { LONG_NAME, UNBROKEN_NAME } from './profile-fixtures';
import { WEB_ORIGIN } from './stack';

// Public boards PR 2: a person's link shows their own card (name, role, handle and cover colour
// only); everything else, and every page that isn't live, shows the general card.

const GENERAL_ALT = 'TipMe. A little tip goes a long way.';

/** Width and height from a PNG's IHDR chunk. */
function pngSize(bytes: Buffer) {
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function card(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect(response.status(), path).toBe(200);
  expect(response.headers()['content-type'], path).toBe('image/png');
  const bytes = await response.body();
  expect(pngSize(bytes), path).toEqual({ width: 1200, height: 630 });
  return bytes;
}

// sharp is the API's dependency (resolved from there), as in photos-not-initials.spec.ts.
const sharp = createRequire(resolve('apps/api/package.json'))('sharp') as (
  input: Buffer,
) => {
  extract(region: {
    left: number;
    top: number;
    width: number;
    height: number;
  }): {
    raw(): { toBuffer(): Promise<Buffer> };
  };
};

/** How many pixels in a region are the logo's black, and how many its purple. */
async function logoInks(
  png: Buffer,
  region: { left: number; top: number; width: number; height: number },
) {
  const data = await sharp(png).extract(region).raw().toBuffer();
  let black = 0;
  let purple = 0;
  // next/og writes RGBA.
  for (let i = 0; i < data.length; i += 4) {
    const [r = 0, g = 0, b = 0] = data.subarray(i, i + 3);
    if (r < 40 && g < 40 && b < 40) black += 1;
    if (Math.abs(r - 0x7a) < 24 && Math.abs(g - 0x32) < 24 && b > 220)
      purple += 1;
  }
  return { black, purple };
}

test('the cards draw the TipMe logo in its black and purple', async ({
  request,
}) => {
  const general = await card(request, '/opengraph-image');
  // The wordmark, top left (232 x 64 at 72, 72).
  const wordmark = await logoInks(general, {
    left: 72,
    top: 72,
    width: 232,
    height: 64,
  });
  expect(wordmark.black).toBeGreaterThan(400);
  expect(wordmark.purple).toBeGreaterThan(400);
  // The heart on its white key, right of centre (232 px key, centred in the card's height).
  const key = await logoInks(general, {
    left: 896,
    top: 199,
    width: 232,
    height: 232,
  });
  expect(key.black).toBeGreaterThan(1000);
  expect(key.purple).toBeGreaterThan(1000);

  // A person's card: the heart on its small white key at the foot, right (80 px, 72 and 48 in).
  const person = await card(request, '/people/ada/share-card');
  const small = await logoInks(person, {
    left: 1048,
    top: 502,
    width: 80,
    height: 80,
  });
  expect(small.black).toBeGreaterThan(200);
  expect(small.purple).toBeGreaterThan(200);
});

async function advertised(page: Page) {
  const og = await page
    .locator('meta[property="og:image"]')
    .getAttribute('content');
  const twitter = await page
    .locator('meta[name="twitter:image"]')
    .getAttribute('content');
  const alt = await page
    .locator('meta[property="og:image:alt"]')
    .getAttribute('content');
  return {
    og: og ? new URL(og, WEB_ORIGIN).pathname : null,
    twitter: twitter ? new URL(twitter, WEB_ORIGIN).pathname : null,
    alt,
  };
}

test('a person’s link advertises their own card', async ({
  page,
  request,
}, testInfo) => {
  await page.goto('/@ada');
  expect(await advertised(page)).toEqual({
    og: '/people/ada/share-card',
    twitter: '/people/ada/share-card',
    alt: 'Ada Okafor on TipMe',
  });
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute(
    'content',
    'summary_large_image',
  );
  // Kept for a look by eye.
  writeFileSync(
    testInfo.outputPath('ada.png'),
    await card(request, '/people/ada/share-card'),
  );
  writeFileSync(
    testInfo.outputPath('general.png'),
    await card(request, '/opengraph-image'),
  );
  await expectAccessible(page);
});

test('home and marketing pages keep the general card', async ({ page }) => {
  for (const path of ['/', '/pro']) {
    await page.goto(path);
    expect(await advertised(page), path).toEqual({
      og: '/opengraph-image',
      twitter: '/opengraph-image',
      alt: GENERAL_ALT,
    });
  }
});

test('an unknown, offline or moved handle gets the general card, not an error', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const general = await card(request, '/opengraph-image');
  // A handle nobody has, and one that isn't a handle at all.
  for (const path of [
    '/people/nobody_here/share-card',
    '/people/no%20such!/share-card',
  ])
    expect(Buffer.compare(await card(request, path), general), path).toBe(0);

  // A page that is not live yet: the general card, and its metadata names no person card.
  const { handle } = await signUpRecipient(page, testInfo, { live: false });
  expect(
    Buffer.compare(
      await card(request, `/people/${handle}/share-card`),
      general,
    ),
  ).toBe(0);
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/@${handle}`);
  expect((await advertised(visitor)).og).not.toContain('/share-card');
  await expectAccessible(visitor);

  // Live, then renamed: the old handle answers the general card.
  await page.getByRole('button', { name: 'Make my page live' }).click();
  await expect(page.getByText('Your page is live')).toBeVisible();
  await expect(async () => {
    const live = await card(request, `/people/${handle}/share-card`);
    expect(Buffer.compare(live, general)).not.toBe(0);
  }).toPass({ timeout: 10_000 });
  const renamed = `${handle}_n`;
  await makePagePro(browser, handle, testInfo);
  await page.goto('/dashboard/settings');
  await page.getByLabel('Username').fill(renamed);
  await page.getByRole('button', { name: 'Change username' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Yes, change it' })
    .click();
  await expect(
    page.getByText(`Old usernames that lead here: @${handle}`),
  ).toBeVisible();
  await expect(async () => {
    const old = await card(request, `/people/${handle}/share-card`);
    expect(Buffer.compare(old, general)).toBe(0);
  }).toPass({ timeout: 10_000 });
});

test('the card changes after the person changes their role', async ({
  page,
  request,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  const path = `/people/${handle}/share-card`;
  const before = await card(request, path);
  await page.getByLabel('What you do').fill('Maths tutor');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(async () => {
    expect(Buffer.compare(await card(request, path), before)).not.toBe(0);
  }).toPass({ timeout: 10_000 });

  // Long, unbroken and Yoruba names still draw a 1200 × 630 card. Kept for a look by eye.
  for (const [name, file] of [
    // The field holds 60 characters, one fewer than LONG_NAME.
    [LONG_NAME.slice(0, 60), 'long-name'],
    [UNBROKEN_NAME, 'unbroken-name'],
    ['Ọlápéjú Ẹ̀kọ́', 'yoruba-name'],
  ] as const) {
    await page.getByLabel('Display name').fill(name);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Saved')).toBeVisible();
    let bytes: Buffer | undefined;
    await expect(async () => {
      await page.goto(`/@${handle}`);
      expect((await advertised(page)).alt).toBe(`${name} on TipMe`);
      bytes = await card(request, path);
    }).toPass({ timeout: 10_000 });
    if (bytes) writeFileSync(testInfo.outputPath(`${file}.png`), bytes);
    await page.goto('/dashboard/settings');
  }
});
