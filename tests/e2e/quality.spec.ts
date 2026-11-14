import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { WEB_ORIGIN } from './stack';

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

// With TipMe for businesses on (the e2e stack): an invitation to create one, no interest form. The
// interest form (flag off) is tested on a stand-in stack in business-setup.spec.ts.
test('business page invites people to create a business when businesses are on', async ({
  page,
}) => {
  await page.goto('/for-businesses');
  await expect(
    page.getByRole('heading', { name: 'Let your customers tip your team.' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toContainText(
    'TipMe staff check your business’s name, address and contact',
  );
  await expect(
    page.getByRole('button', { name: "Tell me when it's ready" }),
  ).toHaveCount(0);
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

test('share cards: profiles advertise their own card, other pages the general one', async ({
  page,
  request,
}) => {
  for (const [path, image, alt] of [
    ['/@ada', '/people/ada/share-card', 'Ada Okafor on TipMe'],
    ['/', '/opengraph-image', 'TipMe. A little thanks goes a long way.'],
  ] as const) {
    await page.goto(path);
    const ogImage = await page
      .locator('meta[property="og:image"]')
      .getAttribute('content');
    expect(new URL(ogImage ?? '', WEB_ORIGIN).pathname, path).toBe(image);
    await expect(
      page.locator('meta[property="og:image:alt"]'),
      path,
    ).toHaveAttribute('content', alt);
    const response = await request.get(image);
    expect(response.status(), path).toBe(200);
    expect(response.headers()['content-type'], path).toBe('image/png');
  }
});

test('responses carry baseline security headers', async ({ request }) => {
  for (const route of [
    '/',
    '/@ada',
    '/opengraph-image',
    '/manifest.webmanifest',
    '/icons/192.png',
    '/people/ada/share-card',
  ]) {
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

test('the terms set out the 10% fee and the NGN 2,000 minimums', async ({
  page,
}) => {
  await page.goto('/legal/terms');
  const fees = page.getByRole('region', { name: 'Fees' });
  await expect(fees).toContainText('you pay exactly the amount you choose');
  await expect(fees).toContainText('TipMe keeps 10% of each tip');
  await expect(fees).toContainText('you receive ₦4,500');
  await expect(fees).toContainText('The smallest tip is ₦2,000');
  await expect(fees).toContainText('The smallest withdrawal is ₦2,000');
});

// The owner, 3 Nov 2026: TipMe can take a username back, with notice, days before.
test('the terms say TipMe can take back a username, with 7 days of notice', async ({
  page,
}) => {
  await page.goto('/legal/terms');
  const usernames = page.getByRole('region', { name: 'Your username' });
  await expect(usernames).toContainText('at least 7 days before we take it');
  await expect(usernames).toContainText('by email or on your dashboard');
  await expect(usernames).toContainText(
    'If we cannot reach you either way within 14 days, we go ahead',
  );
  await expect(usernames).toContainText('ask you to choose a new username');
  await expect(usernames).toContainText(
    'Your page, your tips and your balance stay yours',
  );
  await expect(usernames).toContainText(
    'Links and QR codes that use your old username will stop working',
  );
  await expect(usernames).toContainText(
    'impersonates someone, infringes a trademark, or the law requires it',
  );
});

test('no legal page promises to publish before real payments, which are live', async ({
  page,
}) => {
  for (const path of ['/legal/privacy', '/legal/terms']) {
    await page.goto(path);
    await expect(
      page.getByText(/before TipMe takes real payments/),
    ).toHaveCount(0);
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
    ['/kemi', /\/@kemi$/],
    ['/Kemi', /\/@kemi$/],
    ['/kemi?src=qr', /\/@kemi\?src=qr$/],
  ] as const) {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(308);
    expect(response.headers()['location'], path).toMatch(target);
  }
  for (const path of ['/dashboard', '/sign-in'])
    expect((await request.get(path, { maxRedirects: 0 })).status(), path).toBe(
      200,
    );
  // The example people on TipMe's own pages are reserved handles: no short link, but /@handle works.
  for (const path of ['/ada', '/tobi', '/zainab'])
    expect(
      (await request.get(path, { maxRedirects: 0 })).status(),
      path,
    ).not.toBe(308);
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
    'People already want to tip you.',
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

// The ScreenSmall board. A deeper path under a handle matches no page, so it reaches the site's own
// "not found" screen. (/@handle, and a campaign link /@handle/<ending>, show the one "isn't
// available" screen for every page that cannot be shown, so they never say whether a handle exists.)
test(
  'a missing page names the handle and offers a way on',
  { tag: '@mobile' },
  async ({ page }) => {
    await page.goto('/@tobi_s/tips/more');
    await expect(
      page.getByRole('heading', { name: /^We can.t find @tobi_s\.$/ }),
    ).toBeVisible();
    const main = page.getByRole('main');
    await expect(
      main.getByRole('link', { name: 'Go to TipMe' }),
    ).toHaveAttribute('href', '/');
    await expect(
      main.getByRole('link', { name: 'Get your own page' }),
    ).toHaveAttribute('href', '/sign-up');
    expect(await fitsViewport(page)).toBe(true);
    await expectAccessible(page);
  },
);

test('a missing page normalises the handle, and never echoes anything else', async ({
  page,
}) => {
  await page.goto('/@Tobi_S/tips/more');
  await expect(
    page.getByRole('heading', { name: /^We can.t find @tobi_s\.$/ }),
  ).toBeVisible();
  for (const odd of [
    '/@%3Cscript%3Ealert(1)%3C%2Fscript%3E/tips/more',
    `/@${'a'.repeat(60)}/tips/more`,
    '/@ab/tips/more',
    '/nothing-here/at-all',
  ]) {
    await page.goto(odd);
    await expect(
      page.getByRole('heading', { name: /^We can.t find that page\.$/ }),
    ).toBeVisible();
    await expect(page.locator('main')).not.toContainText('script');
    await expect(page.locator('main')).not.toContainText('aaaaaaaa');
  }
});

test('a campaign link for a page that cannot be shown looks exactly like its /@handle', async ({
  page,
}) => {
  await page.goto('/@tobi_s');
  const heading = page.getByRole('main').getByRole('heading', { level: 1 });
  await expect(heading).toBeVisible();
  const unavailable = await heading.textContent();
  await page.goto('/@tobi_s/tips');
  await expect(heading).toHaveText(unavailable ?? '');
  await expect(page.getByRole('main')).not.toContainText('tips');
});

test('an error says it is on our side and gives a reference', async ({
  page,
}) => {
  // /dev/crash throws on the server when the test inbox is on, and is a 404 otherwise.
  await page.goto('/dev/crash');
  await expect(
    page.getByRole('heading', { name: /^This page didn.t load\.$/ }),
  ).toBeVisible();
  await expect(
    page.getByText(/It.s a problem on our side\. Try again in a moment\./),
  ).toBeVisible();
  // The digest Next logs on the server for this failure.
  await expect(page.getByText(/^Reference: [0-9a-z]{6,}$/i)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expectAccessible(page);
});

test(
  'legal pages keep a readable width',
  { tag: '@mobile' },
  async ({ page }) => {
    for (const route of ['/legal/privacy', '/legal/terms']) {
      await page.goto(route);
      const column = page.locator('main .legal-page__column');
      await expect(column.getByRole('heading', { level: 1 })).toBeVisible();
      const box = await column.boundingBox();
      const rem = await page.evaluate(() =>
        parseFloat(getComputedStyle(document.documentElement).fontSize),
      );
      expect(box?.width ?? Infinity, route).toBeLessThanOrEqual(48 * rem);
      expect(await fitsViewport(page)).toBe(true);
      await expectAccessible(page);
    }
  },
);
