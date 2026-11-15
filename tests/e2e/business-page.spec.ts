import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';
import { sql } from './ops-helpers';

// The business page at /b/<business> (BusinessProfile board, Variant A, approved 6 Nov 2026):
// the business and a card per open location, never a person. One open location goes straight to
// it (307); anything not taking tips is the location page's quiet screen. A manager of the
// business sees a note, added in the browser, so the public HTML stays the same for everyone.

const THREE = [
  { slug: 'vi', name: 'Victoria Island' },
  { slug: 'gone', name: 'Old Branch', closed: true },
  { slug: 'lekki', name: 'Lekki Phase 1' },
];

/** A signed-in owner of a business, with Tobi working at its first location. */
async function owner(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
  {
    status = 'verified',
    locations = THREE,
  }: {
    status?: 'pending' | 'verified' | 'suspended';
    locations?: { slug: string; name: string; closed?: boolean }[];
  } = {},
) {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({
    owner: userId,
    status,
    name: 'The Yellow Chilli',
    locations,
  });
  await seedMember({
    locationId: business.locations[0]!.id,
    profileId,
    shownName: 'Tobi',
    onShift: true,
  });
  return { ...who, userId, business };
}

async function visitor(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

const unavailable = (page: Page) =>
  page.getByRole('main').getByRole('heading', {
    level: 1,
    name: 'This business isn’t taking tips on TipMe right now.',
  });

const noHorizontalScroll = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

test('a verified business lists each open location, links to its page, and names nobody', async ({
  page,
  browser,
}, testInfo) => {
  const { business } = await owner(page, testInfo);
  const { context, page: supporter } = await visitor(browser);
  const response = await supporter.goto(`/b/${business.slug}`);
  expect(response?.status()).toBe(200);
  const main = supporter.getByRole('main');
  const header = main.getByTestId('business-header');
  await expect(
    header.getByRole('heading', { level: 1, name: 'The Yellow Chilli' }),
  ).toBeVisible();
  await expect(header.getByText('Verified business')).toBeVisible();
  await expect(header.getByText('2 places')).toBeVisible();
  const places = main.getByRole('navigation', { name: 'Places' });
  const links = places.getByRole('link');
  await expect(links).toHaveCount(2);
  await expect(links.nth(0)).toHaveAttribute('href', `/b/${business.slug}/vi`);
  await expect(links.nth(0)).toContainText('Victoria Island');
  await expect(links.nth(0)).toContainText('27 Ademola Adetokunbo, Lagos');
  await expect(links.nth(1)).toHaveAttribute(
    'href',
    `/b/${business.slug}/lekki`,
  );
  await expect(links.nth(1)).toContainText('Lekki Phase 1');
  // Closed places are left out; no people, and no shift counts.
  await expect(main.getByText('Old Branch')).toHaveCount(0);
  await expect(main.getByText('Tobi')).toHaveCount(0);
  await expect(main.getByText(/on today/i)).toHaveCount(0);
  await expect(supporter.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    /noindex/,
  );
  await expect(supporter).toHaveTitle(/The Yellow Chilli/);
  // A visitor never sees the managers' note.
  await expect(main.getByRole('note')).toHaveCount(0);
  await expectAccessible(supporter);

  await links.nth(1).click();
  await supporter.waitForURL(new RegExp(`/b/${business.slug}/lekki$`));
  // Nobody is on shift at Lekki, so the header names the place only (owner, 6 Nov 2026).
  await expect(
    supporter
      .getByRole('main')
      .getByTestId('business-header')
      .locator('.business-header__where'),
  ).toHaveText('Lekki Phase 1');
  await context.close();
});

test('a business with one open location goes straight to it, with a temporary redirect', async ({
  page,
  browser,
}, testInfo) => {
  const { business } = await owner(page, testInfo, {
    locations: [
      { slug: 'yaba', name: 'Yaba' },
      { slug: 'shut', name: 'Shut', closed: true },
    ],
  });
  const { context, page: supporter } = await visitor(browser);
  const direct = await supporter.request.get(`/b/${business.slug}`, {
    maxRedirects: 0,
  });
  expect(direct.status()).toBe(307);
  expect(new URL(direct.headers()['location']!, 'http://x').pathname).toBe(
    `/b/${business.slug}/yaba`,
  );
  await supporter.goto(`/b/${business.slug}`);
  await supporter.waitForURL(new RegExp(`/b/${business.slug}/yaba$`));
  await expect(
    supporter
      .getByRole('main')
      .getByRole('link', { name: 'Tobi', exact: true }),
  ).toBeVisible();
  await context.close();
});

test('waiting, paused, every location closed or unknown: the quiet screen, noindex', async ({
  page,
  browser,
}, testInfo) => {
  const { userId } = await owner(page, testInfo);
  const pending = await seedBusiness({ owner: userId, status: 'pending' });
  const paused = await seedBusiness({ owner: userId, status: 'suspended' });
  const closed = await seedBusiness({
    owner: userId,
    locations: [{ slug: 'vi', closed: true }],
  });
  const { context, page: supporter } = await visitor(browser);
  for (const slug of [
    pending.slug,
    paused.slug,
    closed.slug,
    'no-such-business',
  ]) {
    const response = await supporter.goto(`/b/${slug}`);
    expect(response?.status(), slug).toBe(200);
    await expect(unavailable(supporter)).toBeVisible();
    await expect(supporter.locator('meta[name="robots"]')).toHaveAttribute(
      'content',
      /noindex/,
    );
    await expect(
      supporter.getByRole('main').getByRole('navigation', { name: 'Places' }),
    ).toHaveCount(0);
  }
  await expectAccessible(supporter);
  await context.close();
});

test('a manager of the business sees a note saying what visitors see, linking to the dashboard', async ({
  page,
}, testInfo) => {
  const { business, userId } = await owner(page, testInfo);
  await page.goto(`/b/${business.slug}`);
  const main = page.getByRole('main');
  const note = main.getByRole('note');
  await expect(note).toContainText(
    'This is what customers see at your address. Only managers of The Yellow Chilli see this note.',
  );
  await expect(
    note.getByRole('link', { name: 'Go to your business dashboard' }),
  ).toHaveAttribute('href', '/dashboard/business');
  await expect(main.getByRole('navigation', { name: 'Places' })).toBeVisible();
  await expectAccessible(page);

  // Waiting to be verified: the visitor's quiet screen, and the manager learns why.
  const pending = await seedBusiness({
    owner: userId,
    status: 'pending',
    name: 'Ada Bakes',
  });
  await page.goto(`/b/${pending.slug}`);
  await expect(unavailable(page)).toBeVisible();
  await expect(page.getByRole('main').getByRole('note')).toContainText(
    'Customers see the screen below until TipMe verifies Ada Bakes.',
  );
  // Another business's page: no note.
  const stranger = randomUUID();
  await sql(`INSERT INTO users (id) VALUES ($1)`, [stranger]);
  const other = await seedBusiness({ owner: stranger });
  await page.goto(`/b/${other.slug}`);
  await page.waitForURL(new RegExp(`/b/${other.slug}/vi$`));
  await expect(page.getByRole('main').getByRole('note')).toHaveCount(0);
});

test("the dashboard's address on TipMe is a link to the business page", async ({
  page,
}, testInfo) => {
  const { business } = await owner(page, testInfo);
  await page.goto('/dashboard/business');
  const address = page.locator('#details').getByTestId('business-slug');
  await expect(
    address.getByRole('link', { name: `/b/${business.slug}` }),
  ).toHaveAttribute('href', `/b/${business.slug}`);
});

for (const [label, width, height] of [
  ['phone', 390, 844],
  ['wide', 1440, 900],
] as const)
  test(`the business page fits a ${label} screen (${width}px) without sideways scrolling`, async ({
    page,
    browser,
  }, testInfo) => {
    const { business } = await owner(page, testInfo, {
      locations: [
        { slug: 'vi', name: 'Victoria Island and the Very Long Branch Name' },
        { slug: 'lekki', name: 'Lekki Phase 1' },
      ],
    });
    const { context, page: supporter } = await visitor(browser);
    await supporter.setViewportSize({ width, height });
    await supporter.goto(`/b/${business.slug}`);
    const places = supporter
      .getByRole('main')
      .getByRole('navigation', { name: 'Places' });
    await expect(places.getByRole('link')).toHaveCount(2);
    expect(await noHorizontalScroll(supporter)).toBe(true);
    const card = (await places.getByRole('link').first().boundingBox())!;
    expect(card.height).toBeGreaterThanOrEqual(44);
    expect(card.x + card.width).toBeLessThanOrEqual(width);
    await expectAccessible(supporter);
    await context.close();
  });
