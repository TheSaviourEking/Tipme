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
  '/for-creators',
  '/for-businesses',
  '/pro',
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

test('a chosen amount is accessible', async ({ page }) => {
  await page.goto('/@tobi');
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await expectAccessible(page);
});

test('homepage makes creating a recipient page a clear next step', async ({
  page,
}) => {
  await page.goto('/');
  // The claim field starts sign-up with the handle; the closing band is a plain link to it.
  await expect(
    page.getByRole('form', { name: 'Claim your link' }),
  ).toHaveAttribute('action', '/sign-up');
  await expect(
    page.getByRole('main').getByRole('link', { name: 'Claim your username' }),
  ).toHaveAttribute('href', '/sign-up');
  await expect(
    page.getByText(/Payments are in test mode/).last(),
  ).toBeVisible();
  // The owner, 3 Nov 2026: "We need this off 'Examples, not real people.' the website."
  await expect(page.getByText(/examples, not real people/i)).toHaveCount(0);
});

test('business page registers interest and sends nothing until the visitor does', async ({
  page,
}) => {
  await page.goto('/for-businesses');
  await expect(
    page.getByRole('heading', { name: 'TipMe for businesses is on its way.' }),
  ).toBeVisible();
  await page.getByLabel('Work email').fill('business@example.com');
  await page.getByRole('button', { name: "Tell me when it's ready" }).click();
  const emailLink = page.getByRole('link', { name: 'Open email app' });
  const href = await emailLink.getAttribute('href');
  if (!href) throw new Error('The business interest email link has no URL.');
  expect(href).toContain('mailto:usetipme@gmail.com?');
  expect(decodeURIComponent(href.replaceAll('+', ' '))).toContain(
    'business@example.com',
  );
  await expect(page.getByRole('status')).toContainText('press Send');
});

test('arrowing through amounts never pulls focus out of the radio group', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.getByRole('radio', { name: '2,000 NGN' }).focus();
  await page.keyboard.press('ArrowLeft'); // wraps to the last preset
  await expect(page.getByRole('radio', { name: '10,000 NGN' })).toBeFocused();
  await page.keyboard.press('ArrowRight'); // wraps back to the first preset
  await expect(page.getByRole('radio', { name: '2,000 NGN' })).toBeChecked();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel(/^Other amount/)).toBeFocused();
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
    // "Menu" matches both names (Open menu, Close menu); aria-expanded conveys the state.
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
    'TipMe. A little thanks goes a long way.',
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

// The owner, 3 Nov 2026: How it works lives on Home; "we don't need a seperate page".
test('the old How it works address lands on the steps on Home', async ({
  page,
}) => {
  await page.goto('/how-it-works');
  await expect(page).toHaveURL(/\/#how-it-works$/);
  await expect(
    page.getByRole('heading', { name: /in three steps\./ }),
  ).toBeInViewport();
});

test('the creator page exists as a PRD marketing route', async ({ page }) => {
  await page.goto('/for-creators');
  await expect(page).toHaveTitle(/For individuals/);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'People already want to thank you.',
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
    '/#how-it-works',
  );
  await expect(
    nav.getByRole('link', { name: 'Pro', exact: true }),
  ).toHaveAttribute('href', '/pro');
  // The two pages sit under "Who it's for" now (tests/e2e/navigation.spec.ts opens that menu).
  if (testInfo.project.name !== 'mobile')
    await nav.getByRole('button', { name: "Who it's for" }).click();
  await expect(nav.getByRole('link', { name: /^Individuals/ })).toHaveAttribute(
    'href',
    '/for-creators',
  );
  await expect(nav.getByRole('link', { name: /^Businesses/ })).toHaveAttribute(
    'href',
    '/for-businesses',
  );
});

test('How it works in the header glides down Home to the steps', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/');
  if (testInfo.project.name === 'mobile')
    await page.getByRole('button', { name: 'Menu' }).click();
  // Every frame's scroll position from the press on: a jump has one step, a glide many.
  await page.evaluate(() => {
    const seen: number[] = [];
    (window as unknown as { seen: number[] }).seen = seen;
    const frame = () => {
      seen.push(window.scrollY);
      if (seen.length < 120) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'How it works' })
    .click();
  await expect(page).toHaveURL(/\/#how-it-works$/);
  await expect(
    page.getByRole('heading', { name: /in three steps\./ }),
  ).toBeInViewport();
  await page.waitForTimeout(2200);
  const seen = await page.evaluate(
    () => (window as unknown as { seen: number[] }).seen,
  );
  const end = Math.max(...seen);
  const between = new Set(seen.filter((y) => y > 0 && y < end));
  expect(between.size).toBeGreaterThanOrEqual(3);
});
