import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

// The tip receipt (/tip/[tipId]) is one purple from the top of the screen to the bottom of the page
// (owner, 22 Nov 2026): the site header is clear over it with white words and keys, and the footer
// is a translucent card on it. Every state of the receipt, from the first paint. Other pages keep
// their own header and footer.

const PURPLE = 'rgb(122, 50, 249)';
const WHITE = 'rgb(255, 255, 255)';
const CANVAS = 'rgb(243, 242, 238)';
const CLEAR = 'rgba(0, 0, 0, 0)';
// A made-up receipt: the status read is answered here, so no tip is made.
const TIP = '01900000-0000-7000-8000-00000000b1e0';
const RECEIPT = `/tip/${TIP}#t=e2e-receipt-blend-token`;

function view(state: string) {
  return {
    state,
    recipient: { handle: 'ada', displayName: 'Ada Okafor' },
    amountMinor: '200000',
    currency: 'NGN',
    completedAt: state === 'paid' ? '2026-11-22T10:00:00.000Z' : null,
    reference: state === 'paid' ? 'K7Q2XM' : null,
  };
}

/** Answers the receipt's status read: a state, a 404, or never (the loading skeleton). */
async function answerStatus(page: Page, answer: string | 404 | 'never') {
  await page.route('**/v1/tips/*/status', (route) => {
    if (answer === 'never') return;
    const headers = {
      'access-control-allow-origin': route.request().headers()['origin'] ?? '*',
      'access-control-allow-headers': 'authorization',
      'access-control-allow-methods': 'GET',
    };
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers });
    if (answer === 404)
      return route.fulfill({
        status: 404,
        headers,
        json: { error: { code: 'NOT_FOUND' } },
      });
    return route.fulfill({
      status: 200,
      headers,
      json: { data: view(answer) },
    });
  });
}

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const background = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.backgroundColor, image: style.backgroundImage };
    });

/** The page is one purple: html carries it, and nothing between it and the header or footer paints over it. */
async function expectOnePurple(page: Page) {
  const html = await background(page, 'html');
  expect(html.color).toBe(PURPLE);
  // The old slab's soft light at the top, kept (a gradient, not a second colour band).
  expect(html.image).toContain('linear-gradient');
  const painted = await page.evaluate(() => {
    const out: string[] = [];
    for (const start of [
      document.querySelector('.site-header'),
      document.querySelector('.site-footer'),
      document.querySelector('main.tip-status-page'),
    ]) {
      for (let el = start; el && el !== document.documentElement;) {
        const style = getComputedStyle(el);
        if (
          style.backgroundColor !== 'rgba(0, 0, 0, 0)' ||
          style.backgroundImage !== 'none'
        )
          out.push(`${el.tagName}.${el.className}`);
        el = el.parentElement;
      }
    }
    return out;
  });
  expect(painted, 'nothing paints a band over the purple').toEqual([]);
  // The page runs at least to the bottom of the screen, so no canvas shows below it.
  const bottom = await page.evaluate(() => {
    scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: 'instant',
    });
    const hit = document.elementFromPoint(
      document.documentElement.clientWidth / 2,
      document.documentElement.clientHeight - 2,
    );
    return hit?.closest('.site-footer, main') ? 'page' : hit?.tagName;
  });
  expect(bottom).toBe('page');
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
}

async function expectWhiteHeaderAndFooter(page: Page, wide: boolean) {
  const header = page.locator('.site-header');
  expect((await background(page, '.site-header')).color).toBe(CLEAR);
  const logoFills = await header
    .locator('.nav-shell > .brand .brand__mark path')
    .evaluateAll((paths) => paths.map((p) => getComputedStyle(p).fill));
  expect(new Set(logoFills)).toEqual(new Set([WHITE]));
  if (wide) {
    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    for (const link of [
      nav.getByRole('link', { name: 'How it works' }),
      nav.getByRole('button', { name: /^Who it.s for$/ }),
      nav.getByRole('link', { name: 'Pro', exact: true }),
      nav.getByRole('link', { name: 'For businesses' }),
    ])
      await expect(link).toHaveCSS('color', WHITE);
    const signIn = nav.getByRole('link', { name: 'Sign in' });
    await expect(signIn).toHaveCSS('color', WHITE);
    await expect(signIn).toHaveCSS('background-color', CLEAR);
    await expect(signIn).toHaveCSS('background-image', 'none');
    const getTipped = nav.getByRole('link', { name: /Get tipped/ });
    await expect(getTipped).toHaveCSS('background-color', WHITE);
    await expect(getTipped).toHaveCSS('background-image', 'none');
    await expect(getTipped).toHaveCSS('color', PURPLE);
  } else {
    await expect(page.getByRole('button', { name: 'Open menu' })).toHaveCSS(
      'color',
      WHITE,
    );
  }
  const footer = page.locator('.site-footer');
  const footerColours = await footer
    .locator('.footer-card :is(p, h2, a:not(.brand)), .footer-bottom span')
    .evaluateAll((nodes) =>
      nodes
        .filter((n) => n.getClientRects().length > 0)
        .map((n) => `${n.textContent?.trim()}: ${getComputedStyle(n).color}`),
    );
  expect(footerColours.length).toBeGreaterThan(8);
  expect(
    footerColours.filter((entry) => !entry.endsWith(`: ${WHITE}`)),
  ).toEqual([]);
  const footerLogo = await footer
    .locator('.footer-brand .brand__mark path')
    .evaluateAll((paths) => paths.map((p) => getComputedStyle(p).fill));
  expect(new Set(footerLogo)).toEqual(new Set([WHITE]));
  const card = await background(page, '.footer-card');
  // Glass: a translucent white fill, never the old solid paper.
  expect(card.color).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/);
  expect(card.image).toBe('none');
}

async function expectContrast(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations.map(
      ({ id, nodes }) =>
        `${id}: ${nodes.map((n) => n.target.join(' ')).join(', ')}`,
    ),
  ).toEqual([]);
}

for (const [label, width, height] of [
  ['phone', 390, 844],
  ['desktop', 1440, 900],
] as const) {
  const wide = width > 800;
  test.describe(`the receipt, ${label} (${width})`, () => {
    test.use({ viewport: { width, height } });

    test('paid: purple from header to footer, white words, and it passes axe', async ({
      page,
    }) => {
      await answerStatus(page, 'paid');
      await page.goto(RECEIPT);
      await expect(
        page.getByRole('heading', { name: 'Ada Okafor got your tip.' }),
      ).toBeVisible();
      // Test mode: the "Test payment" pill shows on the purple.
      await expect(page.locator('.tip-status-pretend')).toBeVisible();
      await expectOnePurple(page);
      await expectWhiteHeaderAndFooter(page, wide);
      await expectContrast(page);
    });

    test('pending: the same purple ground, and it passes axe', async ({
      page,
    }) => {
      await answerStatus(page, 'waiting');
      await page.goto(RECEIPT);
      await expect(
        page.getByRole('heading', { name: 'Checking your payment' }),
      ).toBeVisible();
      await expectOnePurple(page);
      await expectWhiteHeaderAndFooter(page, wide);
      await expectContrast(page);
    });

    test('focus on the purple is a white ring', async ({ page }) => {
      await answerStatus(page, 'paid');
      await page.goto(RECEIPT);
      await expect(
        page.getByRole('heading', { name: 'Ada Okafor got your tip.' }),
      ).toBeVisible();
      const logo = page.locator('.nav-shell > .brand');
      await logo.focus();
      await expect(logo).toHaveCSS('outline-color', WHITE);
      const link = page
        .getByRole('navigation', { name: 'Footer navigation' })
        .getByRole('link', { name: 'Privacy' });
      await link.focus();
      await expect(link).toHaveCSS('outline-color', WHITE);
    });
  });
}

test.describe('the receipt, every other state', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  for (const [state, heading] of [
    ['declined', 'This payment didn’t go through'],
    ['cancelled', 'This tip expired'],
    [404, 'We couldn’t find this tip'],
  ] as const)
    test(`${state}: purple from header to footer`, async ({ page }) => {
      await answerStatus(page, state);
      await page.goto(RECEIPT);
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
      await expectOnePurple(page);
      await expectWhiteHeaderAndFooter(page, false);
    });

  test('loading: purple while the status is still on its way', async ({
    page,
  }) => {
    await answerStatus(page, 'never');
    await page.goto(RECEIPT);
    await expect(page.locator('main .tm-skeleton').first()).toBeVisible();
    await expectOnePurple(page);
    await expectWhiteHeaderAndFooter(page, false);
  });

  test('the phone menu opens with its usual look over the purple', async ({
    page,
  }) => {
    await answerStatus(page, 'paid');
    await page.goto(RECEIPT);
    await expect(
      page.getByRole('heading', { name: 'Ada Okafor got your tip.' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Open menu' }).click();
    const menu = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(
      menu.getByRole('button', { name: 'Close menu' }),
    ).toBeFocused();
    await expect(menu).toHaveCSS('background-color', CANVAS);
    await expect(menu.getByRole('link', { name: 'How it works' })).toHaveCSS(
      'color',
      'rgb(0, 0, 0)',
    );
    // Sign in keeps its dark words on the menu's canvas, not the header's white ghost key.
    await expect(menu.getByRole('link', { name: 'Sign in' })).toHaveCSS(
      'color',
      'rgb(0, 0, 0)',
    );
    // The menu's own logo keeps its colours.
    const fills = await menu
      .locator('.site-nav__bar .brand__mark path')
      .evaluateAll((paths) => paths.map((p) => getComputedStyle(p).fill));
    expect(fills).toContain(PURPLE);
  });
});

test.describe('without JavaScript (the first paint)', () => {
  test.use({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  test('the server-rendered receipt is already purple, header and footer included', async ({
    page,
  }) => {
    await page.goto(RECEIPT);
    await expect(page.locator('main.tip-status-page')).toBeAttached();
    await expectOnePurple(page);
    expect((await background(page, '.site-header')).color).toBe(CLEAR);
    await expect(page.locator('.tip-status-noscript')).toHaveCSS(
      'color',
      WHITE,
    );
  });
});

test.describe('other pages keep their own header and footer', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  async function expectUsual(page: Page) {
    expect((await background(page, 'html')).color).toBe(CANVAS);
    expect((await background(page, '.site-header')).color).toBe(CANVAS);
    const fills = await page
      .locator('.nav-shell > .brand .brand__mark path')
      .evaluateAll((paths) => paths.map((p) => getComputedStyle(p).fill));
    expect(fills).toContain('rgb(0, 0, 0)');
    expect(fills).not.toContain(WHITE);
  }

  test('Home', async ({ page }) => {
    await page.goto('/');
    await expectUsual(page);
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'How it works' }),
    ).toHaveCSS('color', 'rgb(0, 0, 0)');
    // The footer's raised paper card (--surface-raised), not the receipt's glass.
    await expect(page.locator('.footer-card')).toHaveCSS(
      'background-color',
      'rgb(255, 254, 250)',
    );
    await expect(page.locator('.footer-heading').first()).toHaveCSS(
      'color',
      'rgb(0, 0, 0)',
    );
  });

  test('a tip page (/@ada): its logo-only header', async ({ page }) => {
    await page.goto('/@ada');
    await expectUsual(page);
    await expect(page.locator('.site-nav')).toBeHidden();
  });

  test('leaving the receipt for Home in the app puts the usual header back', async ({
    page,
  }) => {
    await answerStatus(page, 'paid');
    await page.goto(RECEIPT);
    await expect(
      page.getByRole('heading', { name: 'Ada Okafor got your tip.' }),
    ).toBeVisible();
    await page.locator('.nav-shell > .brand').click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(page.locator('.site-header')).toHaveCSS(
      'background-color',
      CANVAS,
    );
    await expectUsual(page);
  });
});
