import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';

// The header a business code opens (owner, 6 Nov 2026): "· on today" only while someone is on
// shift (never a count), and the owner's logo in the tile, the initial without one.

type MakeImage = (options: {
  create: {
    width: number;
    height: number;
    channels: 3;
    background: { r: number; g: number; b: number };
  };
}) => { jpeg(): { toBuffer(): Promise<Buffer> } };
const sharp = createRequire(resolve('apps/api/package.json'))(
  'sharp',
) as MakeImage;
const logoPhoto = () =>
  sharp({
    create: {
      width: 600,
      height: 400,
      channels: 3,
      background: { r: 200, g: 120, b: 20 },
    },
  })
    .jpeg()
    .toBuffer();

async function visit(browser: Browser, path: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page.goto(path);
  expect(response?.status()).toBe(200);
  return { context, page };
}

const header = (page: Page) => page.getByTestId('business-header');

/** A verified business whose one person is (or isn't) on shift at Victoria Island. */
async function businessWithTobi(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
  onShift: boolean,
) {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({ owner: userId });
  await seedMember({
    locationId: business.locations[0]!.id,
    profileId,
    shownName: 'Tobi',
    onShift,
  });
  return { ...who, business };
}

test('with nobody on shift the header names the location only, on the location and staff pages', async ({
  page,
  browser,
}, testInfo) => {
  const { business, handle } = await businessWithTobi(page, testInfo, false);
  const { context, page: visitor } = await visit(
    browser,
    `/b/${business.slug}/vi`,
  );
  const where = header(visitor).locator('.business-header__where');
  await expect(where).toHaveText('Victoria Island');
  await expect(header(visitor)).not.toContainText('on today');

  await visitor.goto(`/b/${business.slug}/vi/${handle}`);
  await expect(where).toHaveText('Victoria Island');
  await expect(header(visitor)).not.toContainText('on today');
  await context.close();
});

test('with someone on shift the header says the location is on today, never how many', async ({
  page,
  browser,
}, testInfo) => {
  const { business, handle } = await businessWithTobi(page, testInfo, true);
  const { context, page: visitor } = await visit(
    browser,
    `/b/${business.slug}/vi`,
  );
  const where = header(visitor).locator('.business-header__where');
  await expect(where).toHaveText('Victoria Island · on today');
  await expect(where).not.toContainText(/\d/);

  await visitor.goto(`/b/${business.slug}/vi/${handle}`);
  await expect(where).toHaveText('Victoria Island · on today');
  await context.close();
});

test('an owner uploads a logo in Details; the public header tile shows it, and Remove logo brings the initial back', async ({
  page,
  browser,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const { userId } = await accountOf(who.email);
  const business = await seedBusiness({ owner: userId, name: 'Kiosk Ade' });

  // Before: the initial.
  const before = await visit(browser, `/b/${business.slug}/vi`);
  await expect(
    header(before.page).getByTestId('business-logo-tile'),
  ).toHaveText('K');
  await before.context.close();

  await page.goto('/dashboard/business');
  const details = page.getByRole('region', { name: 'Details' });
  await details.getByLabel('Choose a logo').setInputFiles({
    name: 'logo.jpg',
    mimeType: 'image/jpeg',
    buffer: await logoPhoto(),
  });
  await expect(
    details.getByRole('status').getByText('Logo saved.'),
  ).toBeVisible();
  // The dashboard's own header shows it too (read through the managers' route).
  const ownTile = page
    .locator('.business-page__head')
    .getByTestId('business-logo-tile')
    .locator('img');
  await expect
    .poll(() => ownTile.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expectAccessible(page);

  const after = await visit(browser, `/b/${business.slug}/vi`);
  const tile = header(after.page).getByTestId('business-logo-tile');
  const image = tile.locator('img');
  await expect(image).toHaveAttribute(
    'src',
    new RegExp(`/v1/business-logos/${business.businessId}/\\d+\\.webp$`),
  );
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expectAccessible(after.page);
  await after.context.close();

  await details.getByRole('button', { name: 'Remove logo' }).click();
  await expect(
    details.getByRole('status').getByText('Logo removed.'),
  ).toBeVisible();
  // The API refreshes the cached public page; give it the moment that takes.
  const removed = await visit(browser, `/b/${business.slug}/vi`);
  await expect
    .poll(async () => {
      await removed.page.reload();
      return header(removed.page)
        .getByTestId('business-logo-tile')
        .textContent();
    })
    .toBe('K');
  await removed.context.close();
});
