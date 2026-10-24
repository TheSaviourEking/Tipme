import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';
import { enrolOwner } from './ops-helpers';

// PR-013: reporting a page, profile photos, tip search, notification preferences and admin
// search, as people would use them.
// sharp is the API's dependency (resolved from there); only the part used here is typed.
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

test('a visitor reports a page and staff find it in the inbox and by search', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/@${handle}`);
  await visitor.getByRole('button', { name: 'Report this page' }).click();
  await visitor
    .getByLabel('What’s wrong with this page?')
    .selectOption('impersonation');
  await expectAccessible(visitor);
  await visitor.getByRole('button', { name: 'Send report' }).click();
  await expect(
    visitor.getByText('Thank you. TipMe will review this page.'),
  ).toBeVisible();

  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.goto('/ops/issues');
  await expect(staff.getByText(`Visitors reported @${handle}`)).toBeVisible();
  await staff.getByRole('link', { name: 'Search' }).click();
  await staff.getByLabel('Search').fill(handle);
  await staff.getByRole('button', { name: 'Search' }).click();
  await expect(staff.getByRole('link', { name: `@${handle}` })).toBeVisible();
  await expectAccessible(staff);
});

test('a recipient adds a photo, searches their tips and turns off tip emails', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const photo = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 122, g: 50, b: 249 },
    },
  })
    .jpeg()
    .toBuffer();
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'me.jpg',
    mimeType: 'image/jpeg',
    buffer: photo,
  });
  await expect(page.getByText('Photo saved.')).toBeVisible();
  await expect(
    page.getByRole('img', { name: /^Photo of / }).first(),
  ).toBeVisible();

  await page
    .getByLabel('Email me about each tip (when my email is verified)')
    .uncheck();
  await page.getByRole('button', { name: 'Save notifications' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(visitor.getByRole('img', { name: /^Photo of / })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 10_000 });

  await tipAsVisitor(browser, handle, { name: 'Bola' });
  await tipAsVisitor(browser, handle, { name: 'Chidi', amount: '5,000 NGN' });
  await page.goto('/dashboard/tips');
  await page.getByLabel('Search').fill('bola');
  await expect(page.getByRole('link', { name: /Tip from Bola/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Tip from Chidi/ })).toHaveCount(
    0,
  );
  await page.getByLabel('Search').fill('5,000');
  await expect(
    page.getByRole('link', { name: /Tip from Chidi/ }),
  ).toBeVisible();
  await page.getByLabel('Search').fill('nobody-here');
  await expect(page.getByText('No tips match “nobody-here”.')).toBeVisible();
  await expectAccessible(page);
});
