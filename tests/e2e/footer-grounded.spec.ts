import { expect, test, type Page } from '@playwright/test';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';
import { signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import {
  STYLE_IDS,
  startStack,
  studioFixtures,
  type Stack,
} from './profile-fixtures';

// The owner, 23 Nov 2026: "The footer must always be grounded to the bottom come what may." On a
// short page the footer (whichever one the page shows: the site's, a tip page's own row, a
// business page's) rests at the bottom edge of the screen, never part-way up with empty space
// below it. On a tall page it follows the content. Every kind of public page, on a phone, a laptop
// and a very tall window.

test.setTimeout(180_000);

const SIZES = [
  { width: 390, height: 844 },
  // A phone held tall: every short page is one screen here.
  { width: 390, height: 1800 },
  // Taller than Sprint's and Horizon's photo-first phone pages.
  { width: 390, height: 2400 },
  { width: 1440, height: 900 },
  { width: 1440, height: 1600 },
  // Taller than even Horizon's photo hero, which alone is over 900px.
  { width: 1440, height: 2200 },
] as const;
const FOOT = '.site-footer, .profile-foot, .business-public__foot';

interface Reading {
  /** The footer the page shows. */
  footerTop: number;
  footerBottom: number;
  isSite: boolean;
  /** The page's height, and the screen's. */
  doc: number;
  screen: number;
  screenWidth: number;
  /** The lowest edge of anything above the footer. */
  contentBottom: number;
  /** The bottom padding and border the footer's ancestors keep under it (the page's gutter, the Tip bar's room). */
  reserve: number;
  /** A tip page's own foot row: the empty space between it and the end of the page's `main`. */
  footRowGap: number | null;
  /** The same reserve, up to that `main` only. */
  footRowReserve: number;
}

/** Waits for the page to settle, then reads where its (last visible) footer sits. */
async function read(page: Page): Promise<Reading> {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return page.evaluate((selector) => {
    const visible = (el: Element) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    };
    /** What the ancestors of \`el\`, up to and including \`top\`, keep under it as padding and border. */
    const below = (el: Element, top: Element) => {
      let sum = 0;
      for (let up = el.parentElement; up; up = up.parentElement) {
        const style = getComputedStyle(up);
        sum +=
          parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth);
        if (up === top) break;
      }
      return sum;
    };
    const feet = [...document.querySelectorAll(selector)].filter(visible);
    const footer = feet.at(-1);
    if (!footer) throw new Error('no footer on the page');
    const box = footer.getBoundingClientRect();
    // What sits above it: every box that ends before the footer starts (in page coordinates).
    let contentBottom = 0;
    for (const el of document.body.querySelectorAll('*')) {
      if (footer.contains(el) || el.contains(footer) || !visible(el)) continue;
      if (
        el.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING
      ) {
        const bottom = el.getBoundingClientRect().bottom + scrollY;
        if (bottom <= box.top + scrollY + 1)
          contentBottom = Math.max(contentBottom, bottom);
      }
    }
    return {
      footerTop: box.top + scrollY,
      footerBottom: box.bottom + scrollY,
      isSite: footer.classList.contains('site-footer'),
      reserve: below(footer, document.body),
      footRowReserve: (() => {
        const row = feet
          .filter((el) => el.classList.contains('profile-foot'))
          .at(-1);
        const main = row?.closest('main');
        return row && main ? below(row, main) : 0;
      })(),
      footRowGap: (() => {
        const row = feet
          .filter((el) => el.classList.contains('profile-foot'))
          .at(-1);
        const main = row?.closest('main');
        return row && main
          ? main.getBoundingClientRect().bottom -
              row.getBoundingClientRect().bottom
          : null;
      })(),
      doc: document.documentElement.scrollHeight,
      screen: document.documentElement.clientHeight,
      screenWidth: document.documentElement.clientWidth,
      contentBottom,
    };
  }, FOOT);
}

/** Short: the footer rests at the screen's bottom and nothing scrolls. Tall: it follows the content. */
function expectGrounded(r: Reading, label: string) {
  // Never less than a screen, and the footer ends the page: under it only what its ancestors pad
  // it with (a tip page's gutter, the room the sticky Tip bar needs, the dashboard's bottom bar),
  // measured from the page itself.
  expect(
    r.doc,
    `${label}: the page is at least a screen`,
  ).toBeGreaterThanOrEqual(r.screen);
  const gap = r.doc - r.footerBottom;
  expect(gap, `${label}: the footer ends the page`).toBeGreaterThanOrEqual(-1);
  expect(gap, `${label}: no empty space under the footer`).toBeLessThanOrEqual(
    r.reserve + 1,
  );
  // A tip page's own foot row rests at the bottom of its page, the same way.
  if (r.footRowGap !== null)
    expect(
      r.footRowGap,
      `${label}: no empty space under the foot row`,
    ).toBeLessThanOrEqual(r.footRowReserve + 1);
  // After the content, with no overlap.
  expect(
    r.footerTop,
    `${label}: the footer comes after the content`,
  ).toBeGreaterThanOrEqual(r.contentBottom - 1);
}

/** On a window taller than the page, the page is exactly one screen: no scrolling at all. */
function expectOneScreen(r: Reading, label: string) {
  expect(r.doc, `${label}: a short page does not scroll`).toBeLessThanOrEqual(
    r.screen + 1,
  );
  expect(
    r.footerBottom,
    `${label}: the footer is at the bottom of the screen`,
  ).toBeGreaterThanOrEqual(r.screen - r.reserve - 1);
  expect(r.footerBottom, `${label}: not past it`).toBeLessThanOrEqual(
    r.screen + 1,
  );
}

/**
 * `short` is true when the page is shorter than a 1600px-tall window, or the least window height (px)
 * the page is shorter than; on such a window the page is one screen and the footer is on its bottom edge.
 */
async function check(
  page: Page,
  path: string,
  short: boolean | number,
  phoneFrom = 1800,
) {
  for (const size of SIZES) {
    await page.setViewportSize(size);
    await page.goto(path);
    await page.getByRole('main').first().waitFor();
    const label = `${path} at ${size.width}x${size.height}`;
    const r = await read(page);
    expectGrounded(r, label);
    // The very tall windows are taller than any of these short pages: one screen, no scrolling.
    const from = short === true ? 1600 : short;
    if (from && size.height >= (size.width < 1024 ? phoneFrom : from))
      expectOneScreen(r, label);
  }
}

test.describe('a tip page on its own web instance', () => {
  test.describe.configure({ mode: 'serial' });
  let stack: Stack;
  test.beforeAll(async () => {
    await studioFixtures();
    stack = await startStack('test');
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  const visit = (
    page: Page,
    path: string,
    short: boolean | number,
    phoneFrom?: number,
  ) =>
    check(
      page,
      path.startsWith('http') ? path : `${stack.origin}${path}`,
      short,
      phoneFrom,
    );

  test('Classic with a cover', async ({ page }) => {
    await visit(page, '/@shortcover', true);
  });

  test('Classic with no cover', async ({ page }) => {
    await visit(page, '/@shortnocover', true);
  });

  test('Classic with every block, a tall page', async ({ page }) => {
    await visit(page, '/@styleclassic', false);
  });

  for (const style of STYLE_IDS)
    test(`the ${style} style, short and with its example blocks`, async ({
      page,
    }) => {
      await visit(
        page,
        `/@short${style}`,
        style === 'horizon' ? 2200 : true,
        style === 'horizon' || style === 'sprint' ? 2400 : 1800,
      );
      await visit(page, `/@style${style}`, false);
    });
});

test.describe('the rest of the site', () => {
  test('the sign-in page and a missing page: the site footer', async ({
    page,
  }) => {
    await check(page, '/sign-in', true);
    await check(page, '/no-such-page-footer-grounded', true);
  });

  test('a tall marketing page: the footer follows the content', async ({
    page,
  }) => {
    await check(page, '/', false);
    await check(page, '/pro', false);
  });

  test('a business staff tip page and its location page', async ({
    page,
    browser,
  }, testInfo) => {
    const who = await signUpRecipient(page, testInfo);
    const { userId, profileId } = await accountOf(who.email);
    const business = await seedBusiness({
      owner: userId,
      status: 'verified',
      name: 'The Yellow Chilli',
      locations: [{ slug: 'vi', name: 'Victoria Island' }],
    });
    await seedMember({
      locationId: business.locations[0]!.id,
      profileId,
      shownName: 'Tobi',
      onShift: true,
    });
    const context = await browser.newContext();
    const visitor = await context.newPage();
    await check(visitor, `/b/${business.slug}/vi/${who.handle}`, true);
    await check(visitor, `/b/${business.slug}/vi`, true);
    await check(visitor, `/b/${business.slug}`, true);
    await context.close();
  });

  test('the dashboard keeps its slim footer at the bottom', async ({
    page,
  }, testInfo) => {
    await signUpRecipient(page, testInfo, { live: false });
    await check(page, '/dashboard/tips', true);
  });
});

test.describe('the owner page', () => {
  // The owner's report (23 Nov): a Free page on a big laptop screen, name "Mad", bio "Mad at madda",
  // the standard Classic page with its preset strip, and the footer row (Report this page, Privacy,
  // Terms, Learn about this preview, Get your own TipMe page) part-way up the screen.
  test('a Free Classic page with a short bio, at 1800x1170 and 1440x900', async ({
    page,
    browser,
  }, testInfo) => {
    const who = await signUpRecipient(page, testInfo);
    await sql(
      `UPDATE profiles SET display_name = 'Mad', bio = 'Mad at madda' WHERE handle_lower = $1`,
      [who.handle],
    );
    const context = await browser.newContext();
    const visitor = await context.newPage();
    for (const size of [
      { width: 1800, height: 1170 },
      { width: 1440, height: 900 },
    ]) {
      await visitor.setViewportSize(size);
      await visitor.goto(`/@${who.handle}`);
      await expect(
        visitor.getByRole('heading', { level: 1, name: 'Mad' }),
      ).toBeVisible();
      await expect(visitor.getByText('Mad at madda')).toBeVisible();
      const label = `/@${who.handle} at ${size.width}x${size.height}`;
      const r = await read(visitor);
      expectGrounded(r, label);
      // The page is shorter than the window: one screen, and its foot row on the bottom edge less
      // only the page's own bottom padding (no bar, no handle, nothing else is reserved here).
      expectOneScreen(r, label);
      expect(
        r.footRowGap,
        `${label}: only the page's 2rem gutter under the foot row`,
      ).toBeLessThanOrEqual(33);
      // Nothing is fixed to the bottom of the screen at this width.
      const fixed = await visitor.evaluate(
        () =>
          [...document.querySelectorAll('body *')].filter((el) => {
            const box = el.getBoundingClientRect();
            return (
              getComputedStyle(el).position === 'fixed' &&
              box.width > 0 &&
              box.height > 0 &&
              box.bottom > innerHeight - 80
            );
          }).length,
      );
      expect(fixed, `${label}: no bar or handle fixed to the bottom`).toBe(0);
    }
    await context.close();
  });
});

test.describe('the receipt', () => {
  const TIP = '01900000-0000-7000-8000-00000000f007';

  test('purple to the bottom, with its footer on the bottom edge', async ({
    page,
  }) => {
    await page.route('**/v1/tips/*/status', (route) => {
      const headers = {
        'access-control-allow-origin':
          route.request().headers()['origin'] ?? '*',
        'access-control-allow-headers': 'authorization',
        'access-control-allow-methods': 'GET',
      };
      if (route.request().method() === 'OPTIONS')
        return route.fulfill({ status: 204, headers });
      return route.fulfill({
        status: 200,
        headers,
        json: {
          data: {
            state: 'paid',
            recipient: { handle: 'ada', displayName: 'Ada Okafor' },
            amountMinor: '200000',
            currency: 'NGN',
            completedAt: '2026-11-22T10:00:00.000Z',
            reference: 'K7Q2XM',
          },
        },
      });
    });
    for (const size of SIZES) {
      await page.setViewportSize(size);
      await page.goto(`/tip/${TIP}#t=e2e-footer-grounded-token`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const label = `receipt at ${size.width}x${size.height}`;
      const r = await read(page);
      expectGrounded(r, label);
      if (size.height >= 1600) expectOneScreen(r, label);
      // Still one purple from top to bottom.
      expect(
        await page.evaluate(
          () => getComputedStyle(document.documentElement).backgroundColor,
        ),
      ).toBe('rgb(122, 50, 249)');
    }
  });
});
