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
  '/for-businesses',
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

test('the quoted payer total is accessible', async ({ page }) => {
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).check();
  await expect(page.getByText('You pay NGN 2,000.00')).toBeVisible();
  await expectAccessible(page);
});

test('homepage makes creating a recipient page a clear next step', async ({
  page,
}) => {
  await page.goto('/');
  await expect(
    page
      .getByRole('main')
      .getByRole('link', { name: /Create your page/ })
      .first(),
  ).toHaveAttribute('href', '/sign-up');
  await expect(page.getByText('Want to receive tips?')).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Your page. Your link. Your thanks.' }),
  ).toBeVisible();
  await expect(
    page.getByText(/Payments are in test mode/).last(),
  ).toBeVisible();
  await expect(page.locator('.home-hero__portrait figcaption')).toContainText(
    'fictional demo recipient',
  );
});

test('business page clearly says accounts are not open yet', async ({
  page,
}) => {
  await page.goto('/for-businesses');
  await expect(
    page.getByRole('heading', { name: 'Business pages are not open yet.' }),
  ).toBeVisible();
  await expect(
    page.getByText(/have not announced a launch date/),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: /Create an individual page/ }),
  ).toHaveAttribute('href', '/sign-up');
  await page.getByLabel('Your email address').fill('business@example.com');
  await page.getByRole('button', { name: 'Prepare email' }).click();
  const emailLink = page.getByRole('link', { name: 'Open email app' });
  const href = await emailLink.getAttribute('href');
  if (!href) throw new Error('The business interest email link has no URL.');
  expect(href).toContain('mailto:usetipme@gmail.com?');
  expect(decodeURIComponent(href.replaceAll('+', ' '))).toContain(
    'business@example.com',
  );
  await expect(page.getByRole('status')).toContainText(
    'press Send to register your interest',
  );
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

test('design-system tactile controls retain native button and radio semantics', async ({
  page,
}) => {
  await page.goto('/design-system');
  await expect(page.getByRole('button', { name: 'Primary' })).toHaveAttribute(
    'type',
    'button',
  );
  await expect(page.getByRole('radio', { name: 'Selected' })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Option' })).not.toBeChecked();
  await expect(
    page.locator('.material-specimen[data-material="raised"]'),
  ).toBeVisible();
  await expect(
    page.locator('[data-material="recessed"]').first(),
  ).toBeVisible();
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
    expect(headers['content-security-policy'], route).toContain(
      "default-src 'self'",
    );
    expect(headers['content-security-policy'], route).toContain(
      "object-src 'none'",
    );
    expect(headers['content-security-policy'], route).toContain(
      "script-src 'self' 'unsafe-inline'",
    );
    expect(headers['permissions-policy'], route).toContain('camera=()');
    expect(headers['x-powered-by'], route).toBeUndefined();
  }
});

test('legal pages say they are coming soon, linked from every page', async ({
  page,
}) => {
  for (const [path, title] of [
    ['/legal/privacy', 'Privacy notice'],
    ['/legal/terms', 'Terms of use'],
  ] as const) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(page.getByText('Coming soon', { exact: true })).toBeVisible();
    await expect(page).toHaveTitle(new RegExp(title));
  }
  await page.goto('/');
  const footer = page.getByRole('navigation', { name: 'Footer navigation' });
  await footer.getByRole('link', { name: 'Privacy' }).click();
  await expect(page).toHaveURL(/\/legal\/privacy$/);
});

test('old /people links permanently redirect to /@handle', async ({
  request,
}) => {
  const response = await request.get('/people/ada', { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers()['location']).toMatch(/\/@ada$/);
});

test('short /handle links permanently redirect to /@handle without shadowing pages', async ({
  request,
}) => {
  for (const [path, target] of [
    ['/ada', /\/@ada$/],
    ['/Ada', /\/@ada$/],
    ['/ada?src=qr', /\/@ada\?src=qr$/],
  ] as const) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(308);
    expect(response.headers()['location'], path).toMatch(target);
  }
  for (const path of ['/dashboard', '/sign-in'])
    expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(
      200,
    );
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
  await expect(page).toHaveTitle(/For individuals/);
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
  await expect(
    nav.getByRole('link', { name: 'For individuals' }),
  ).toHaveAttribute('href', '/for-creators');
  await expect(
    nav.getByRole('link', { name: 'For Businesses' }),
  ).toHaveAttribute('href', '/for-businesses');
});
