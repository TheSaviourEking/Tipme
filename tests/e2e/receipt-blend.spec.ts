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

/** Each logo's two colours (globals.css .wordmark): its ink (::before) and its accent (::after). */
const logoColours = (marks: Element[]) =>
  marks.flatMap((m) =>
    ['::before', '::after'].map(
      (part) => getComputedStyle(m, part).backgroundColor,
    ),
  );

async function expectWhiteHeaderAndFooter(page: Page, wide: boolean) {
  const header = page.locator('.site-header');
  expect((await background(page, '.site-header')).color).toBe(CLEAR);
  // The logo all white: its ink (the dark file's white) and its purple, which would vanish here.
  const logoFills = await header
    .locator('.nav-shell > .brand .brand__mark')
    .evaluateAll(logoColours);
  expect(logoFills).toHaveLength(2);
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
    .locator('.footer-brand .brand__mark')
    .evaluateAll(logoColours);
  expect(footerLogo).toHaveLength(2);
  expect(new Set(footerLogo)).toEqual(new Set([WHITE]));
  const card = await background(page, '.footer-card');
  // Glass: a translucent white fill, never the old solid paper.
  expect(card.color).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/);
  expect(card.image).toBe('none');
}

/** axe as a supplement only: it can't judge text over the page's gradient (it reports it incomplete). */
async function expectNoAxeViolations(page: Page) {
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

type Rgba = [number, number, number, number];

function parseColour(value: string): Rgba {
  const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
  if (!/^rgba?\(/.test(value) || parts.length < 3)
    throw new Error(`not an rgb colour: ${value}`);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

/** `top` painted over an opaque `under`, in sRGB as the browser composites it. */
function over([r, g, b, a]: Rgba, under: Rgba): Rgba {
  return [
    r * a + under[0] * (1 - a),
    g * a + under[1] * (1 - a),
    b * a + under[2] * (1 - a),
    1,
  ];
}

function luminance([r, g, b]: Rgba) {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgba, b: Rgba) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

// The page's known ground: the purple, and its lightest point, the top of the 10% white light
// (the header sits there). Worst case for white words.
const GROUND = parseColour(PURPLE);
const TOP_LIGHT = over([255, 255, 255, 0.1], GROUND);

/** Each element's computed text colour, its size class, and its own background colour. */
const styles = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((nodes) =>
    nodes
      .filter((n) => n.getClientRects().length > 0)
      .map((n) => {
        const style = getComputedStyle(n);
        const size = parseFloat(style.fontSize);
        const weight = Number(style.fontWeight);
        return {
          name: `${n.tagName.toLowerCase()} "${n.textContent?.trim().slice(0, 30)}"`,
          colour: style.color,
          fill: style.backgroundColor,
          // WCAG large text: 24px, or 18.66px bold.
          large: size >= 24 || (size >= 18.66 && weight >= 700),
        };
      }),
  );

/**
 * WCAG contrast computed from the browser's own colours against the known ground: 4.5:1 for
 * normal text, 3:1 for large. axe can't do this here (the ground is a gradient).
 */
async function expectContrastOnPurple(
  page: Page,
  { wide, heading }: { wide: boolean; heading: boolean },
) {
  const failures: string[] = [];
  const check = (what: string, colour: string, ground: Rgba, min: number) => {
    const ratio = contrast(over(parseColour(colour), ground), ground);
    if (ratio < min) failures.push(`${what}: ${ratio.toFixed(2)} < ${min}`);
    return ratio;
  };
  const checked = { header: 0, footer: 0 };

  // Header: on the lightest point of the top light.
  const header = await styles(
    page,
    wide
      ? '.site-nav > a:not(.tm-button), .site-nav .who__button, .site-nav > .tm-button--secondary'
      : '.nav-shell > .menu-toggle',
  );
  for (const item of header) {
    // The phone menu key is an icon: 3:1 (non-text contrast).
    check(
      `header ${item.name}`,
      item.colour,
      TOP_LIGHT,
      wide ? (item.large ? 3 : 4.5) : 3,
    );
    checked.header += 1;
  }
  if (wide) {
    const [key] = await styles(page, '.site-nav > .tm-button--primary');
    expect(key, 'Get tipped').toBeDefined();
    const fill = over(parseColour(key!.fill), TOP_LIGHT);
    check(`Get tipped words on its fill`, key!.colour, fill, 4.5);
    // The key's fill against the page: the control's edge (non-text, 3:1).
    const edge = contrast(fill, TOP_LIGHT);
    if (edge < 3)
      failures.push(`Get tipped fill on the page: ${edge.toFixed(2)} < 3`);
    checked.header += 1;
  }

  // The paid heading sits on the purple, under the light's fade: judged on the lightest point.
  if (heading) {
    for (const h1 of await styles(page, 'main .tip-thanks .tip-status-live h1'))
      check(`receipt ${h1.name}`, h1.colour, TOP_LIGHT, h1.large ? 3 : 4.5);
  }

  // Footer: the glass card's own computed fill over the plain purple, then the © line beside it.
  const card = await background(page, '.footer-card');
  const glass = over(parseColour(card.color), GROUND);
  for (const item of await styles(
    page,
    '.footer-card :is(p, h2, a:not(.brand))',
  )) {
    check(`footer ${item.name}`, item.colour, glass, item.large ? 3 : 4.5);
    checked.footer += 1;
  }
  for (const item of await styles(page, '.footer-bottom > span')) {
    check(`footer ${item.name}`, item.colour, GROUND, item.large ? 3 : 4.5);
    checked.footer += 1;
  }

  expect(checked.header).toBeGreaterThan(wide ? 4 : 0);
  expect(checked.footer).toBeGreaterThan(8);
  expect(failures).toEqual([]);
}

for (const [label, width, height] of [
  ['phone', 390, 844],
  ['desktop', 1440, 900],
] as const) {
  const wide = width > 800;
  test.describe(`the receipt, ${label} (${width})`, () => {
    test.use({ viewport: { width, height } });

    test('paid: purple from header to footer, white words, AA contrast', async ({
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
      await expectContrastOnPurple(page, { wide, heading: true });
      await expectNoAxeViolations(page);
    });

    test('pending: the same purple ground, AA contrast', async ({ page }) => {
      await answerStatus(page, 'waiting');
      await page.goto(RECEIPT);
      await expect(
        page.getByRole('heading', { name: 'Checking your payment' }),
      ).toBeVisible();
      await expectOnePurple(page);
      await expectWhiteHeaderAndFooter(page, wide);
      await expectContrastOnPurple(page, { wide, heading: false });
      await expectNoAxeViolations(page);
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
      .locator('.site-nav__bar .brand__mark')
      .evaluateAll(logoColours);
    expect(fills).toEqual(['rgb(0, 0, 0)', PURPLE]);
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
      .locator('.nav-shell > .brand .brand__mark')
      .evaluateAll(logoColours);
    // The light logo: black ink, purple accent.
    expect(fills).toEqual(['rgb(0, 0, 0)', PURPLE]);
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
