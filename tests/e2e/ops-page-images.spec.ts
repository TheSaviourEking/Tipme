import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner } from './ops-helpers';
import { API_ORIGIN } from './stack';

// Staff review a page's uploaded images (Task 2). The viewer fetches each image from the API
// with the staff member's session cookie, from another origin, so the cookie, CORS and the
// content policy all have to line up: only a browser run shows that.
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

const jpeg = (width: number, height: number) =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 122, g: 50, b: 249 },
    },
  })
    .jpeg()
    .toBuffer();

test('staff view a page’s cover and photo with their session, and remove the cover with a reason', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'me.jpg',
    mimeType: 'image/jpeg',
    buffer: await jpeg(800, 800),
  });
  await expect(page.getByText('Photo saved.')).toBeVisible();
  await page.getByLabel('Upload your own photo').setInputFiles({
    name: 'cover.jpg',
    mimeType: 'image/jpeg',
    buffer: await jpeg(1600, 500),
  });
  await expect(page.getByText('Cover saved.')).toBeVisible();

  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.getByRole('link', { name: 'Pages' }).click();
  await staff.getByLabel('Handle').fill(handle);
  await staff.getByRole('button', { name: 'Find page' }).click();
  await expect(
    staff.getByRole('heading', { name: 'Images', exact: true }),
  ).toBeVisible();
  // Nothing is fetched until a staff member asks, because each view is logged.
  await expect(
    staff.getByRole('img', { name: `The cover of @${handle}` }),
  ).toHaveCount(0);

  const request = staff.waitForRequest(
    (r) =>
      r.url().startsWith(`${API_ORIGIN}/v1/ops/pages/`) &&
      r.url().endsWith('/images/cover'),
  );
  const response = staff.waitForResponse(
    (r) =>
      r.url().startsWith(`${API_ORIGIN}/v1/ops/pages/`) &&
      r.url().endsWith('/images/cover'),
  );
  await staff.getByRole('button', { name: 'View cover' }).click();
  // It travels with the staff session, and the API lets this origin read the answer.
  expect((await (await request).allHeaders()).cookie ?? '').toContain('=');
  const answer = await response;
  expect(answer.status()).toBe(200);
  expect(await answer.headerValue('access-control-allow-credentials')).toBe(
    'true',
  );
  const cover = staff.getByRole('img', { name: `The cover of @${handle}` });
  await expect(cover).toBeVisible();
  await expect
    .poll(() => cover.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);

  await staff.getByRole('button', { name: 'View photo' }).click();
  const photo = staff.getByRole('img', { name: `The photo of @${handle}` });
  await expect(photo).toBeVisible();
  await expect
    .poll(() => photo.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBeGreaterThan(0);
  await expectAccessible(staff);

  // Removing the cover needs a reason, and leaves the photo alone.
  await staff.getByRole('button', { name: 'Remove cover…' }).click();
  await staff
    .getByLabel('Why is this cover being removed?')
    .fill('Not suitable for a public page');
  await staff
    .getByRole('button', { name: 'Remove cover', exact: true })
    .click();
  await expect(staff.getByRole('button', { name: 'View cover' })).toHaveCount(
    0,
  );
  await expect(photo).toBeVisible();

  // The owner is back on a design, not a broken image.
  await page.reload();
  await expect(
    page.getByTestId('cover-preview').locator('[data-profile-cover]'),
  ).toHaveAttribute('data-profile-cover', /^(scattered|large|dark)$/);
});
