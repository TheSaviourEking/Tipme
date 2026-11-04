import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';
import { makePagePro } from './ops-helpers';
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
  await page.getByRole('button', { name: 'Report this note' }).click();
  await page.getByLabel('What’s wrong with it?').selectOption('spam');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(
    page.getByText(
      'You reported this note. It is hidden, and TipMe is reviewing it.',
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
  await makePagePro(browser, handle, testInfo);
  await page.goto('/dashboard/settings');
  await page.getByLabel('Handle').fill(renamed);
  await page.getByRole('button', { name: 'Change handle' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Yes, change it' })
    .click();
  await expect(
    page.getByText(
      `Saved. Your page is now at ${new URL(page.url()).host}/@${renamed}.`,
    ),
  ).toBeVisible();
  await expect(
    page.getByText(`Old handles that lead here: @${handle}`),
  ).toBeVisible();
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  const seen: string[] = [];
  visitor.on('framenavigated', (frame) => seen.push(frame.url()));
  await expect(async () => {
    // A printed QR code points at the old handle with ?src=qr.
    const response = await visitor.goto(`/@${handle}?src=qr`);
    expect(response?.ok()).toBe(true);
    // A streamed Next.js redirect can finish after goto resolves. Wait before retrying the old
    // link. Printed QR codes keep their source marker through the redirect; once counted, the
    // analytics client removes it from the address, so the arrival is checked from the log.
    await expect(visitor).toHaveURL(new RegExp(`/@${renamed}(\\?src=qr)?$`), {
      timeout: 2000,
    });
    expect(seen.some((url) => url.endsWith(`/@${renamed}?src=qr`))).toBe(true);
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
