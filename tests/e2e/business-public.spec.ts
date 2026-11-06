import { expect, test, type Browser, type Page } from '@playwright/test';
import { startTip } from '../shared/tip-flow';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';
import { sql } from './ops-helpers';

// TipMe for businesses, PR B4: scan a location code, pick the person, tip them with today's form.
// The e2e stack runs with BUSINESS_ENABLED=true (playwright.config.ts).

/** A live page that works at a verified business, on shift unless said. */
async function staffAt(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
  {
    status = 'verified',
    locations = [{ slug: 'vi', name: 'Victoria Island' }],
    at = 0,
    onShift = true,
  }: {
    status?: 'verified' | 'suspended';
    locations?: { slug: string; name: string }[];
    at?: number;
    onShift?: boolean;
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
  const { memberId } = await seedMember({
    locationId: business.locations[at]!.id,
    profileId,
    shownName: 'Tobi',
    onShift,
  });
  return { ...who, profileId, memberId, business };
}

async function visitor(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

const paid = (page: Page) =>
  expect(
    page.getByRole('heading', { name: /^.+ got your thanks\.$/ }),
  ).toBeVisible({ timeout: 20_000 });

async function payOnMockCheckout(page: Page) {
  await page.waitForURL(/\/mock-checkout\//);
  await page.getByRole('button', { name: /^Pay/ }).click();
  await page.waitForURL(/\/tip\/[0-9a-f-]{36}/);
  return new URL(page.url()).pathname.split('/')[2] ?? '';
}

test('scan → pick → tip: the paid tip credits the person and is labelled with the location', async ({
  page,
  browser,
}, testInfo) => {
  const staff = await staffAt(page, testInfo);
  const { slug, locations } = staff.business;
  const { context, page: supporter } = await visitor(browser);
  const response = await supporter.goto(`/b/${slug}/vi?src=qr`);
  expect(response?.status()).toBe(200);
  await expect(
    supporter.getByRole('heading', { level: 1, name: 'The Yellow Chilli' }),
  ).toBeVisible();
  await expect(supporter.getByText('Victoria Island · on today')).toBeVisible();
  await expect(
    supporter.getByRole('heading', { name: 'On today' }),
  ).toBeVisible();
  await expect(supporter.locator('meta[name="robots"]')).toHaveAttribute(
    'content',
    /noindex/,
  );
  await expect(supporter).toHaveTitle(/The Yellow Chilli/);
  await expectAccessible(supporter);

  await supporter.getByRole('link', { name: 'Tobi', exact: true }).click();
  await supporter.waitForURL(
    new RegExp(`/b/${slug}/vi/${staff.handle}\\?src=qr$`),
  );
  await expect(
    supporter.getByRole('heading', {
      level: 1,
      name: 'Tobi at The Yellow Chilli',
    }),
  ).toBeVisible();
  await expect(
    supporter.getByRole('heading', { name: 'Tip Tobi at The Yellow Chilli' }),
  ).toBeVisible();
  await expect(supporter.getByText('Verified business')).toBeVisible();
  await expectAccessible(supporter);

  await startTip(supporter);
  const tipId = await payOnMockCheckout(supporter);
  await paid(supporter);
  const [tip] = await sql<{
    profile_id: string;
    business_member_id: string | null;
    business_location_id: string | null;
  }>(
    `SELECT profile_id, business_member_id, business_location_id FROM tips WHERE id = $1`,
    [tipId],
  );
  expect(tip).toEqual({
    profile_id: staff.profileId,
    business_member_id: staff.memberId,
    business_location_id: locations[0]!.id,
  });
  await context.close();
});

test('the header with the verified line is visible at 360px before any person @mobile', async ({
  page,
  browser,
}, testInfo) => {
  const staff = await staffAt(page, testInfo);
  const { context, page: supporter } = await visitor(browser);
  await supporter.setViewportSize({ width: 360, height: 740 });
  await supporter.goto(`/b/${staff.business.slug}/vi`);
  const header = supporter.getByTestId('business-header');
  const verified = header.getByText('Verified business');
  await expect(verified).toBeInViewport();
  await expect(
    header.getByText(
      'TipMe checked this business’s name, address and contact.',
    ),
  ).toBeInViewport();
  const person = supporter.getByRole('link', { name: 'Tobi', exact: true });
  const headerBox = (await header.boundingBox())!;
  const personBox = (await person.boundingBox())!;
  expect(headerBox.y + headerBox.height).toBeLessThanOrEqual(personBox.y);
  // A tap target, and nothing wider than the phone.
  expect(personBox.height).toBeGreaterThanOrEqual(44);
  expect(await fitsViewport(supporter)).toBe(true);
  await expectAccessible(supporter);
  // The staff page on a phone: the header, then the person's own form with its Tip bar.
  await person.click();
  await expect(header).toBeInViewport();
  await expect(supporter.getByRole('button', { name: /^Tip ₦/ })).toBeVisible();
  expect(await fitsViewport(supporter)).toBe(true);
  await context.close();
});

test('"I don\'t see them" finds someone at another location of the business', async ({
  page,
  browser,
}, testInfo) => {
  const staff = await staffAt(page, testInfo, {
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'ikoyi', name: 'Ikoyi' },
    ],
    at: 1,
  });
  const { context, page: supporter } = await visitor(browser);
  await supporter.goto(`/b/${staff.business.slug}/vi?src=qr`);
  await expect(
    supporter.getByRole('heading', {
      name: 'Nobody here is taking tips on TipMe yet.',
    }),
  ).toBeVisible();
  // Too short to search: it says so, and nothing is asked of the API.
  await supporter.getByRole('button', { name: 'I don’t see them' }).click();
  await expect(
    supporter.getByText('Type at least 2 letters of their name first.'),
  ).toBeVisible();
  await supporter.getByLabel('Search a name').fill('tob');
  await supporter.getByRole('button', { name: 'I don’t see them' }).click();
  const found = supporter.getByRole('link', { name: 'Tobi at Ikoyi' });
  await expect(found).toBeVisible();
  await expect(found).toHaveAttribute(
    'href',
    `/b/${staff.business.slug}/ikoyi/${staff.handle}?src=qr`,
  );
  await expectAccessible(supporter);
  // Nobody of that name anywhere: said plainly.
  await supporter.getByLabel('Search a name').fill('zz');
  await supporter.getByRole('button', { name: 'I don’t see them' }).click();
  await expect(
    supporter.getByText(
      'Nobody at The Yellow Chilli called “zz” takes tips on TipMe yet.',
    ),
  ).toBeVisible();
  await context.close();
});

test('with "Remember my tips" ticked, the next visit offers "Tip Tobi again"; without it, nothing is stored', async ({
  page,
  browser,
}, testInfo) => {
  const staff = await staffAt(page, testInfo);
  const location = `/b/${staff.business.slug}/vi`;
  const tipThere = async (supporter: Page, remember: boolean) => {
    await supporter.goto(`${location}/${staff.handle}`);
    await supporter.getByRole('radio', { name: '2,000 NGN' }).click();
    if (remember) {
      await supporter.getByText('Add a message, reason or your name').click();
      await supporter.getByLabel('Remember my tips on this phone').check();
    }
    await supporter.getByRole('button', { name: /^Tip ₦/ }).click();
    await payOnMockCheckout(supporter);
    await paid(supporter);
  };

  const kept = await visitor(browser);
  await tipThere(kept.page, true);
  await kept.page.goto(location);
  const again = kept.page.getByTestId('tip-again');
  await expect(again).toBeVisible();
  await expect(again).toContainText('Tip Tobi again');
  await expect(again).toHaveAttribute('href', `${location}/${staff.handle}`);
  await expectAccessible(kept.page);
  await kept.context.close();

  const forgotten = await visitor(browser);
  await tipThere(forgotten.page, false);
  await forgotten.page.goto(location);
  await expect(
    forgotten.page.getByRole('link', { name: 'Tobi', exact: true }),
  ).toBeVisible();
  await expect(forgotten.page.getByTestId('tip-again')).toHaveCount(0);
  expect(
    await forgotten.page.evaluate(() =>
      localStorage.getItem('tipme.myTips.v1'),
    ),
  ).toBeNull();
  await forgotten.context.close();
});

test("a suspended business shows it is not taking tips; a left member's staff code opens their own page", async ({
  page,
  browser,
}, testInfo) => {
  const staff = await staffAt(page, testInfo);
  const { context, page: supporter } = await visitor(browser);
  const paused = await seedBusiness({
    owner: (await accountOf(staff.email)).userId,
    status: 'suspended',
  });
  const response = await supporter.goto(`/b/${paused.slug}/vi`);
  expect(response?.status()).toBe(200);
  await expect(
    supporter.getByRole('heading', {
      level: 1,
      name: 'This business isn’t taking tips on TipMe right now.',
    }),
  ).toBeVisible();
  await expect(supporter.getByRole('link', { name: 'Tobi' })).toHaveCount(0);
  await expectAccessible(supporter);

  await sql(
    `UPDATE business_members SET left_at = now(), left_by = 'self' WHERE id = $1`,
    [staff.memberId],
  );
  await supporter.goto(`/b/${staff.business.slug}/vi/${staff.handle}?src=qr`);
  await supporter.waitForURL(new RegExp(`/@${staff.handle}\\?src=qr$`));
  // Their own page: no business, so the tip is not labelled.
  await expect(supporter.getByText('at The Yellow Chilli')).toHaveCount(0);
  await expect(supporter.getByTestId('business-header')).toHaveCount(0);
  await context.close();
});
