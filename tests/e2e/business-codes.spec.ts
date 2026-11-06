import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';
import { sql } from './ops-helpers';
import { WEB_ORIGIN } from './stack';

// TipMe for businesses, PR B8: printed location signs and staff badges. Every printed code must
// scan to the right URL, so each canvas is read back pixel for pixel and decoded.

// The web's shapes for B1's BusinessDetail and B3's MyMembership (packages/contracts), as far as
// these pages read them; the tools tsconfig does not resolve workspace packages.
type Status = 'pending' | 'verified' | 'suspended';
type BusinessDetail = { id: string; status: Status } & Record<string, unknown>;

type Decode = (
  data: Uint8ClampedArray,
  w: number,
  h: number,
) => { data: string } | null;
const jsQR = createRequire(resolve('apps/web/package.json'))('jsqr') as Decode;
// sharp is the API's dependency (resolved from there), as in qr.spec.ts.
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

/** What a scanner reads from the drawn canvas, at the resolution it prints (sent as a PNG). */
async function scan(canvas: Locator): Promise<string | undefined> {
  const png = await canvas.evaluate((element) => {
    const target = element as HTMLCanvasElement;
    return target.width === 0 ? null : target.toDataURL('image/png');
  });
  if (!png) return undefined;
  const { data, info } = await sharp(
    Buffer.from(png.replace(/^data:image\/png;base64,/, ''), 'base64'),
  )
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data;
}

/**
 * The Business page draws its sections from B1's detail route, and the Work page from B3's work
 * route; neither is on this branch, so the test answers them with what those routes return. The
 * codes themselves always come from the real API.
 */
async function answerDetail(page: Page, detail: BusinessDetail) {
  await page.route(
    (url) => url.pathname === `/v1/me/businesses/${detail.id}`,
    (route) => route.fulfill({ json: { data: detail } }),
  );
}
const detailOf = (
  businessId: string,
  slug: string,
  status: Status,
  locations: { id: string; slug: string; name: string }[],
): BusinessDetail => ({
  id: businessId,
  slug,
  name: 'The Yellow Chilli',
  status,
  slugLocked: status !== 'pending',
  contact: { name: 'Funke', email: 'funke@example.com' },
  locations: locations.map((location) => ({
    ...location,
    address: '27 Ademola Adetokunbo, Lagos',
    closed: false,
  })),
  you: { role: 'owner' },
});

test('a verified business shows each sign and badge, and each decodes to its URL with src=qr', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const { businessId, slug, locations } = await seedBusiness({
    owner: userId,
    locations: [{ slug: 'vi', name: 'Victoria Island' }],
  });
  await seedMember({
    locationId: locations[0]!.id,
    profileId,
    shownName: 'Kemi',
  });
  await answerDetail(
    page,
    detailOf(businessId, slug, 'verified', [
      { id: locations[0]!.id, slug: 'vi', name: 'Victoria Island' },
    ]),
  );
  await page.goto('/dashboard/business');
  const codes = page.getByRole('region', { name: 'Codes' });
  const sign = codes.getByRole('img', { name: /^Sign for Victoria Island/ });
  await expect(sign).toBeVisible();
  await expect.poll(() => scan(sign)).toBe(`${WEB_ORIGIN}/b/${slug}/vi?src=qr`);
  await expect(codes.getByText('Kemi', { exact: true })).toBeVisible();
  await expectAccessible(page);

  const download = page.waitForEvent('download');
  await codes.getByRole('button', { name: 'Download Kemi’s badge' }).click();
  expect((await download).suggestedFilename()).toBe(
    `tipme-${slug}-kemi-badge.png`,
  );

  await codes.getByRole('link', { name: 'Print every badge' }).click();
  await expect(page).toHaveURL(/\/dashboard\/business\/codes\/print\?/);
  await expect(page.getByRole('radio', { name: /Staff badge/ })).toBeChecked();
  const badge = page.getByRole('img', {
    name: /^Badge for Kemi at The Yellow Chilli/,
  });
  await expect
    .poll(() => scan(badge))
    .toBe(`${WEB_ORIGIN}/b/${slug}/vi/${who.handle}?src=qr`);
});

test('print page: one sign per page, text names visible, expectAccessible', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  const { businessId, slug } = await seedBusiness({
    owner: userId,
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'ikeja', name: 'Ikeja' },
      { slug: 'old', name: 'Old Yaba', closed: true },
    ],
  });
  await page.goto(`/dashboard/business/codes/print?business=${businessId}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Print your codes' }),
  ).toBeVisible();
  await expect(
    page.getByRole('radio', { name: /Location sign/ }),
  ).toBeChecked();
  const signs = page.getByRole('img', { name: /^Sign for / });
  await expect(signs).toHaveCount(2);
  await expect(page.getByText('The Yellow Chilli · Ikeja')).toBeVisible();
  await expect(
    page.getByText('The Yellow Chilli · Victoria Island'),
  ).toBeVisible();
  await expect(page.getByText('Old Yaba')).toHaveCount(0);
  for (const [index, location] of [
    [0, 'ikeja'],
    [1, 'vi'],
  ] as const)
    await expect
      .poll(() => scan(signs.nth(index)))
      .toBe(`${WEB_ORIGIN}/b/${slug}/${location}?src=qr`);
  await expectAccessible(page);

  // The purple style and the table tent decode the same.
  await page.getByRole('radio', { name: 'Purple' }).check();
  await page.getByRole('radio', { name: /Table tent/ }).check();
  await expect
    .poll(() => scan(signs.first()))
    .toBe(`${WEB_ORIGIN}/b/${slug}/ikeja?src=qr`);

  // On paper: the controls go, and each sheet ends its page.
  await page.emulateMedia({ media: 'print' });
  await expect(page.getByRole('radio', { name: /Table tent/ })).toBeHidden();
  const breaks = await page
    .locator('.business-print__sheet')
    .evaluateAll((sheets) =>
      sheets.map((sheet) => getComputedStyle(sheet).breakAfter),
    );
  expect(breaks).toEqual(['page', 'auto']);
});

test('codes are refused until verified: nothing is drawn for a pending business', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  const { businessId, slug, locations } = await seedBusiness({
    owner: userId,
    status: 'pending',
  });
  await answerDetail(
    page,
    detailOf(businessId, slug, 'pending', [
      { id: locations[0]!.id, slug: 'vi', name: 'Victoria Island' },
    ]),
  );
  await page.goto('/dashboard/business');
  const codes = page.getByRole('region', { name: 'Codes' });
  await expect(
    codes.getByText(
      'Your codes can be printed once TipMe verifies The Yellow Chilli, so no sign goes up that leads nowhere.',
    ),
  ).toBeVisible();
  await expect(codes.locator('canvas')).toHaveCount(0);
  await expectAccessible(page);

  await page.goto(`/dashboard/business/codes/print?business=${businessId}`);
  await expect(
    page.getByText('Codes can be printed once TipMe verifies this business.'),
  ).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);
});

test('Work → My code: the member’s own badge, downloadable once verified, scanning to their staff page', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const { businessId, slug, locations } = await seedBusiness({ owner: userId });
  const { memberId } = await seedMember({
    locationId: locations[0]!.id,
    profileId,
    shownName: 'Kemi',
  });
  const membership = (status: Status): Record<string, unknown> => ({
    memberId,
    business: { id: businessId, name: 'The Yellow Chilli', slug, status },
    location: { id: locations[0]!.id, name: 'Victoria Island', slug: 'vi' },
    shownName: 'Kemi',
    showPhoto: true,
    shareAmounts: false,
    onShift: false,
    staffCodePath: `/b/${slug}/vi/${who.handle}`,
  });
  let status: Status = 'pending';
  await page.route(
    (url) => url.pathname === '/v1/me/work',
    (route) => route.fulfill({ json: { data: [membership(status)] } }),
  );
  await page.goto('/dashboard/work');
  await expect(
    page.getByText(
      'Your badge can be downloaded once TipMe verifies The Yellow Chilli.',
    ),
  ).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(0);

  status = 'verified';
  await page.reload();
  const badge = page.getByRole('img', {
    name: /^Your badge at The Yellow Chilli/,
  });
  await expect
    .poll(() => scan(badge))
    .toBe(`${WEB_ORIGIN}/b/${slug}/vi/${who.handle}?src=qr`);
  await expectAccessible(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download your badge' }).click();
  expect((await download).suggestedFilename()).toBe(
    `tipme-${slug}-vi-badge.png`,
  );
});

test('a member who left has no badge in the business’s codes', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId, profileId } = await accountOf(who.email);
  const { businessId, locations } = await seedBusiness({ owner: userId });
  const { memberId } = await seedMember({
    locationId: locations[0]!.id,
    profileId,
    shownName: 'Kemi',
  });
  await sql(
    `UPDATE business_members SET left_at = now(), left_by = 'self' WHERE id = $1`,
    [memberId],
  );
  await page.goto(
    `/dashboard/business/codes/print?business=${businessId}&format=badge`,
  );
  await expect(
    page.getByText(
      'Nobody works here on TipMe yet, so there are no badges to print.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('img', { name: /^Badge for / })).toHaveCount(0);
});
