import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const routes = [
  '/',
  '/@ada',
  '/@tobi',
  '/about-preview',
  '/design-system',
  '/preview-states',
  '/@not-a-person',
  '/how-it-works',
  '/for-creators',
  '/legal/privacy',
  '/legal/terms',
];
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(wcag)
    .analyze();
  expect(
    violations.map(
      ({ id, nodes }) =>
        `${id}: ${nodes.map((node) => node.target.join(' ')).join(', ')}`,
    ),
  ).toEqual([]);
}
const fitsViewport = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const route of routes) {
  test(`${route} passes axe, reflows and stays noindex`, async ({ page }) => {
    await page.goto(route);
    // Next adds its own `noindex` on not-found responses; every robots tag must exclude indexing.
    const robots = await page
      .locator('meta[name="robots"]')
      .evaluateAll((tags) => tags.map((tag) => tag.getAttribute('content')));
    expect(robots.length).toBeGreaterThan(0);
    for (const content of robots) expect(content).toContain('noindex');
    expect(await fitsViewport(page)).toBe(true);
    await expectAccessible(page);
  });
}

test('every route reflows at 320px (equivalent to 1280px at 400% zoom)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 720 });
  for (const route of routes) {
    await page.goto(route);
    expect(await fitsViewport(page), route).toBe(true);
  }
});

test('the quoted breakdown is accessible', async ({ page }) => {
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(
    page.getByText(/^Tobi receives NGN [\d,]+\.\d\d after fees$/),
  ).toBeVisible();
  await expectAccessible(page);
});

test('arrowing through amounts never pulls focus out of the radio group', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.getByRole('radio', { name: '1,000 NGN' }).focus();
  await page.keyboard.press('ArrowLeft'); // wraps to "Other"
  await expect(page.getByRole('radio', { name: 'Other amount' })).toBeFocused();
  await page.keyboard.press('ArrowRight'); // wraps back to the first preset
  await expect(page.getByRole('radio', { name: '1,000 NGN' })).toBeChecked();
  await page.getByRole('radio', { name: 'Other amount' }).check();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Your amount (NGN)')).toBeFocused();
});

test('reduced motion disables skeleton animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/preview-states');
  const animation = await page
    .locator('.tm-skeleton > span:not(.sr-only)')
    .first()
    .evaluate((node) => getComputedStyle(node).animationName);
  expect(animation).toBe('none');
});

test(
  'mobile navigation opens, closes with Escape and returns focus',
  {
    tag: '@mobile',
  },
  async ({ page }, testInfo) => {
    test.skip(
      testInfo.project.name !== 'mobile',
      'Disclosure is only shown on narrow viewports.',
    );
    await page.goto('/');
    const toggle = page.getByRole('button', { name: 'Menu' });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    // The accessible name stays constant; only aria-expanded conveys state.
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const firstLink = page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'How it works' });
    await firstLink.focus();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Menu' })).toBeFocused();
    await expect(firstLink).toBeHidden();
  },
);

test('share card is a prerendered PNG advertised on profiles', async ({
  page,
  request,
}) => {
  await page.goto('/@ada');
  const ogImage = await page
    .locator('meta[property="og:image"]')
    .getAttribute('content');
  expect(ogImage).toMatch(/\/opengraph-image/);
  await expect(page.locator('meta[property="og:image:alt"]')).toHaveAttribute(
    'content',
    /Non-transactional/,
  );
  const response = await request.get(
    new URL(ogImage ?? '', 'http://127.0.0.1:3100').pathname,
  );
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/png');
});

test('responses carry baseline security headers', async ({ request }) => {
  for (const route of ['/', '/@ada', '/opengraph-image']) {
    const headers = (await request.get(route)).headers();
    expect(headers['x-content-type-options'], route).toBe('nosniff');
    expect(headers['referrer-policy'], route).toBe(
      'strict-origin-when-cross-origin',
    );
    expect(headers['x-frame-options'], route).toBe('DENY');
    expect(headers['content-security-policy'], route).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers['permissions-policy'], route).toContain('camera=()');
    expect(headers['x-powered-by'], route).toBeUndefined();
  }
});

test('legal pages are clearly labelled placeholders, linked from every page', async ({
  page,
}) => {
  for (const [path, title] of [
    ['/legal/privacy', 'Privacy notice'],
    ['/legal/terms', 'Terms of use'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(
      page
        .getByText('Placeholder — not a legal document', { exact: false })
        .first(),
    ).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(`${title} \\(placeholder\\)`));
  }
  await page.goto('/');
  const footer = page.getByRole('navigation', { name: 'Footer navigation' });
  await footer.getByRole('link', { name: 'Privacy (placeholder)' }).click();
  await expect(page).toHaveURL(/\/legal\/privacy$/);
});

test('old /people links permanently redirect to /@handle', async ({
  request,
}) => {
  const response = await request.get('/people/ada', { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers()['location']).toMatch(/\/@ada$/);
});

test('how it works and creator pages exist as PRD marketing routes', async ({
  page,
}) => {
  await page.goto('/how-it-works');
  await expect(page).toHaveTitle(/How it works/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'How TipMe works',
  );
  await expect(page.locator('main ol.steps > li')).toHaveCount(3);
  await page.goto('/for-creators');
  await expect(page).toHaveTitle(/For creators/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'For the generous minds',
  );
  await page
    .getByRole('main')
    .getByRole('link', { name: /Meet a demo creator/ })
    .click();
  await expect(page).toHaveURL(/\/@ada$/);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
    'href',
    /\/@ada$/,
  );
});

test('main navigation points to the marketing pages', async ({
  page,
}, testInfo) => {
  await page.goto('/');
  if (testInfo.project.name === 'mobile')
    await page.getByRole('button', { name: 'Menu' }).click();
  const nav = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(nav.getByRole('link', { name: 'How it works' })).toHaveAttribute(
    'href',
    '/how-it-works',
  );
  await expect(nav.getByRole('link', { name: 'For creators' })).toHaveAttribute(
    'href',
    '/for-creators',
  );
});
