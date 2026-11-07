import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness } from './business-fixtures';
import { enrolOwner, openOpsLink, sql } from './ops-helpers';

// TipMe for businesses, release 1 close-out: an owner is told that their location pages read "isn't
// taking tips" until TipMe verifies the business, and staff open each location's public page from
// the ops detail.

test('a waiting business is told its location pages show “not taking tips” until verified', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  await seedBusiness({ owner: userId, status: 'pending', name: 'Ada Bakes' });
  await page.goto('/dashboard/business');
  await expect(page.getByTestId('business-preview-note')).toHaveText(
    'Until TipMe verifies Ada Bakes, your location pages show “This business isn’t taking tips on TipMe right now.” to everyone, you included.',
  );
  await expectAccessible(page);
});

test('a verified business is not told that', async ({ page }, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  await seedBusiness({ owner: userId, status: 'verified', name: 'Ada Bakes' });
  await page.goto('/dashboard/business');
  await expect(page.getByTestId('business-status')).toHaveText(
    'Verified business',
  );
  await expect(page.getByTestId('business-preview-note')).toHaveCount(0);
});

test('staff open each location’s public page from the business detail', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const [owner] = await sql<{ id: string }>(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`owner.${randomUUID().slice(0, 8)}@example.com`],
  );
  const name = `Chilli ${randomUUID().slice(0, 6)}`;
  const { businessId, slug } = await seedBusiness({
    owner: owner!.id,
    status: 'pending',
    name,
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'ikoyi', name: 'Ikoyi' },
    ],
  });
  await openOpsLink(page, 'Businesses');
  await page.goto(`/ops/businesses/${businessId}`);
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  const locations = page.getByRole('list', { name: 'Locations' });
  const vi = locations.getByRole('link', {
    name: `/b/${slug}/vi: Victoria Island’s public page (opens in a new tab)`,
  });
  await expect(vi).toHaveAttribute('href', `/b/${slug}/vi`);
  await expect(vi).toHaveAttribute('target', '_blank');
  await expect(
    locations.getByRole('link', { name: /Ikoyi’s public page/ }),
  ).toHaveAttribute('href', `/b/${slug}/ikoyi`);
  await expectAccessible(page);
});
