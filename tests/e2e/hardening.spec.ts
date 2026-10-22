import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';
import { API_ORIGIN } from './stack';

// PR-011: a recipient reports a message, renames their page (old links and QR codes keep working),
// and crawlers are kept out of preview copies.

test('a recipient reports an abusive message and it disappears from their dashboard', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, {
    name: 'Spammy S.',
    message: 'Buy followers cheap',
  });
  await page.goto('/dashboard/tips');
  await page.getByRole('link', { name: /Tip from Spammy S\./ }).click();
  await expect(page.getByText('Buy followers cheap')).toBeVisible();
  await page.getByRole('button', { name: 'Report message…' }).click();
  await page.getByLabel('What’s wrong with it?').selectOption('spam');
  await expectAccessible(page);
  await page
    .getByRole('button', { name: 'Report message', exact: true })
    .click();
  await expect(
    page.getByText(
      'You reported this message. It is hidden, and TipMe is reviewing it.',
    ),
  ).toBeVisible();
  await expect(page.getByText('Buy followers cheap')).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Buy followers cheap')).toHaveCount(0);
});

test('a renamed page keeps its old link and QR code working, and nobody can take the old handle', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  const renamed = `${handle}_n`;
  await page.goto('/dashboard/settings');
  await page.getByLabel('Handle').fill(renamed);
  await page.getByRole('button', { name: 'Change handle' }).click();
  await expect(
    page.getByText(`Saved. Your page is now at tipme.app/@${renamed}.`),
  ).toBeVisible();
  await expect(
    page.getByText(`Old handles that lead here: @${handle}`),
  ).toBeVisible();
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    // A printed QR code points at the old handle with ?src=qr.
    const response = await visitor.goto(`/@${handle}?src=qr`);
    expect(response?.ok()).toBe(true);
    expect(new URL(visitor.url()).pathname).toBe(`/@${renamed}`);
  }).toPass({ timeout: 10_000 });
  await expect(visitor.getByText(`@${renamed}`).first()).toBeVisible();

  const availability = await (
    await visitor.request.get(`${API_ORIGIN}/v1/handles/${handle}/availability`)
  ).json();
  expect(availability.data.status).toBe('taken');
});

test('crawlers are asked to stay out of this preview copy', async ({
  page,
}) => {
  const robots = await page.request.get('/robots.txt');
  expect(robots.ok()).toBe(true);
  expect(await robots.text()).toMatch(/User-Agent: \*\s+Disallow: \//i);
  const sitemap = await page.request.get('/sitemap.xml');
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).not.toContain('<loc>');
});
