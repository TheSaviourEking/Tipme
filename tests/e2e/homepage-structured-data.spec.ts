import { expect, test } from '@playwright/test';

// The description is the one in payment-mode-copy.ts (HOME_DESCRIPTION). It holds in every
// payment mode, so the spec pins the words.
const HOME_DESCRIPTION =
  'Get tipped with a link or QR code. TipMe lets people and teams receive tips from the people who appreciate them.';

test('the home page has one JSON-LD script naming TipMe, and a description that says what it does', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    'content',
    HOME_DESCRIPTION,
  );
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    'content',
    HOME_DESCRIPTION,
  );
  const scripts = page.locator('script[type="application/ld+json"]');
  await expect(scripts).toHaveCount(1);
  const data = JSON.parse((await scripts.textContent()) ?? '');
  const origin = new URL(page.url()).origin;
  expect(data['@context']).toBe('https://schema.org');
  expect(
    data['@graph'].map((node: { '@type': string }) => node['@type']),
  ).toEqual(['Organization', 'WebSite']);
  const [org, site] = data['@graph'];
  expect(org.name).toBe('TipMe');
  expect(site.description).toBe(HOME_DESCRIPTION);
  expect(org.url).toMatch(/^https?:\/\/[^/]+\/$/);
  expect(org.logo).toMatch(/^https?:\/\/.+\/icons\/192\.png$/);
  // The logo it names exists.
  const logo = await page.request.get(
    new URL(new URL(org.logo).pathname, origin).toString(),
  );
  expect(logo.status()).toBe(200);
});

test('other marketing pages do not carry the home page graph', async ({
  page,
}) => {
  for (const path of ['/for-creators', '/for-businesses']) {
    await page.goto(path);
    await expect(
      page.locator('script[type="application/ld+json"]'),
      path,
    ).toHaveCount(0);
  }
});
