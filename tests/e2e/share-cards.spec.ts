import { writeFileSync } from 'node:fs';
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

const GENERAL_ALT = 'TipMe. A little thanks goes a long way.';

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
  await page.getByLabel('Handle').fill(renamed);
  await page.getByRole('button', { name: 'Change handle' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Yes, change it' })
    .click();
  await expect(
    page.getByText(`Old handles that lead here: @${handle}`),
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
