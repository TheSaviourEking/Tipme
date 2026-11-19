import { expect, test, type Page } from '@playwright/test';
import { startStack, type Stack } from './profile-fixtures';

// Moving on within the site keeps the page someone left mounted, hidden, for the way back (Next 16:
// React's Activity puts an inline `display: none !important` on its top elements). Rules that read
// the page from the outside (`body:has(.profile-page)`, `html:has(.studio[data-header])`) must
// read only the page on screen: leaving a tip page must give the next page its own header, and
// arriving on one must give the tip page's header (the logo alone, over a styled page's cover).

/** Moves within the site as a <Link> does, for the hops with no link on the page. */
const push = async (page: Page, href: string) => {
  await page.evaluate(
    (to) =>
      (
        window as unknown as { next: { router: { push(h: string): void } } }
      ).next.router.push(to),
    href,
  );
  await page.waitForURL((url) => url.pathname === href);
};

/** The way it was left: the old page is still in the document, hidden. */
const expectKeptHidden = async (page: Page, label: string) =>
  expect(
    page.locator('body > main[style*="display: none"]'),
    `${label}: Next keeps the page left behind, hidden`,
  ).not.toHaveCount(0);

const header = (page: Page) =>
  page.evaluate(() => {
    const h = document.querySelector('.site-header')!;
    const style = getComputedStyle(h);
    return {
      background: style.backgroundColor,
      color: style.color,
      position: style.position,
      scrim: getComputedStyle(h, '::before').content,
      glass: getComputedStyle(h, '::after').content,
      logo: getComputedStyle(h.querySelector('.brand__mark')!).height,
      html: getComputedStyle(document.documentElement).backgroundColor,
    };
  });

/** Today's site header on `/` and `/pro`: the full menu, solid, the full-size logo. */
async function expectSiteHeader(page: Page, label: string) {
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'How it works' }),
    label,
  ).toBeVisible();
  const h = await header(page);
  // tokens.css --canvas; the wordmark at 2.5rem (globals.css .brand__mark).
  expect(h.background, `${label}: solid`).toBe('rgb(243, 242, 238)');
  expect(h.scrim, `${label}: no scrim over a cover`).toBe('none');
  expect(h.glass, `${label}: no glass`).toBe('none');
  expect(h.color, `${label}: today's words`).not.toBe('rgb(255, 255, 255)');
  expect(h.logo, `${label}: the full-size logo`).toBe('40px');
  expect(h.html, `${label}: the site's own page colour`).toBe(
    'rgb(243, 242, 238)',
  );
}

/** A styled page with a photo cover: the logo alone, over the cover, white on its scrim. */
async function expectOverCover(page: Page, label: string) {
  await page.locator('main:not([style]) .studio[data-header="over"]').waitFor();
  await expect(page.locator('.site-header .site-nav'), label).toBeHidden();
  await expect(
    page.getByRole('button', { name: 'Open menu' }),
    label,
  ).toHaveCount(0);
  const h = await header(page);
  expect(h.background, `${label}: transparent`).toBe('rgba(0, 0, 0, 0)');
  expect(h.color, `${label}: white over the cover`).toBe('rgb(255, 255, 255)');
  expect(h.scrim, `${label}: the scrim`).not.toBe('none');
}

/** The standard page's header: the logo alone, at the profile's size, solid. */
async function expectStandardTipHeader(page: Page, label: string) {
  await page.locator('main.profile-page:not([style])').waitFor();
  await expect(page.locator('.site-header .site-nav'), label).toBeHidden();
  const h = await header(page);
  expect(h.background, `${label}: solid`).toBe('rgb(243, 242, 238)');
  expect(h.scrim, `${label}: no scrim`).toBe('none');
  expect(h.logo, `${label}: the profile's logo`).toBe('30px');
}

test.describe('on the full stack', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('from the standard tip page to Home, /pro and another tip page', async ({
    page,
  }) => {
    await page.goto('/@ada');
    await expectStandardTipHeader(page, '/@ada');
    await page
      .locator('.site-header')
      .getByRole('link', { name: 'TipMe home' })
      .click();
    await page.waitForURL((url) => url.pathname === '/');
    await expectKeptHidden(page, '/@ada → /');
    await expectSiteHeader(page, '/@ada → /');

    await page.goto('/@ada');
    await page.getByRole('main').waitFor();
    await push(page, '/pro');
    await expectKeptHidden(page, '/@ada → /pro');
    await expectSiteHeader(page, '/@ada → /pro');

    await page.goto('/@ada');
    await page.getByRole('main').waitFor();
    await push(page, '/@tobi');
    await expectStandardTipHeader(page, '/@ada → /@tobi');
  });

  test('from a styled page to Home, /pro and the standard tip page', async ({
    page,
  }) => {
    // The lab stands in for a styled tip page (Stage, a photo cover: the header over it).
    const lab = '/dev/studio-lab?style=stage&mode=light';
    await page.goto(lab);
    await expectOverCover(page, 'the lab');
    await page
      .locator('.site-header')
      .getByRole('link', { name: 'TipMe home' })
      .click();
    await page.waitForURL((url) => url.pathname === '/');
    await expectKeptHidden(page, 'lab → /');
    await expectSiteHeader(page, 'lab → /');

    await page.goto(lab);
    await expectOverCover(page, 'the lab');
    await push(page, '/pro');
    await expectKeptHidden(page, 'lab → /pro');
    await expectSiteHeader(page, 'lab → /pro');

    await page.goto(lab);
    await expectOverCover(page, 'the lab');
    // The site's footer under a styled page: "Try the demo" (test copies only).
    await page
      .locator('.site-footer')
      .getByRole('link', { name: 'Try the demo' })
      .click();
    await page.waitForURL((url) => url.pathname === '/@ada');
    await expectKeptHidden(page, 'lab → /@ada');
    await expectStandardTipHeader(page, 'lab → /@ada');
  });

  test('from Home to the standard tip page and to a styled page', async ({
    page,
  }) => {
    await page.goto('/');
    await expectSiteHeader(page, '/');
    await page
      .locator('.site-footer')
      .getByRole('link', { name: 'Try the demo' })
      .click();
    await page.waitForURL((url) => url.pathname === '/@ada');
    await expectKeptHidden(page, '/ → /@ada');
    await expectStandardTipHeader(page, '/ → /@ada');

    await page.goto('/');
    await expectSiteHeader(page, '/');
    await page.evaluate(() =>
      (
        window as unknown as { next: { router: { push(h: string): void } } }
      ).next.router.push('/dev/studio-lab?style=stage&mode=light'),
    );
    await page.waitForURL(/\/dev\/studio-lab/);
    await expectOverCover(page, '/ → the lab');
  });
});

test.describe('on a published styled page', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let stack: Stack;
  test.beforeAll(async () => {
    stack = await startStack('test');
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  test('from /@stylestage to Home, and to another styled tip page', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${stack.origin}/@stylestage`);
    await expectOverCover(page, '/@stylestage');
    await page
      .locator('.site-header')
      .getByRole('link', { name: 'TipMe home' })
      .click();
    await page.waitForURL((url) => url.pathname === '/');
    await expectKeptHidden(page, '/@stylestage → /');
    await expectSiteHeader(page, '/@stylestage → /');

    // Stage to Clear on a gradient: Clear starts on its own bg, so the header is solid there.
    await page.goto(`${stack.origin}/@stylestage`);
    await expectOverCover(page, '/@stylestage');
    await push(page, '/@styleclear');
    await page
      .locator('main:not([style]) .studio[data-style="clear"]')
      .waitFor();
    await expectKeptHidden(page, '/@stylestage → /@styleclear');
    const clear = await page.evaluate(() =>
      document
        .querySelector('main:not([style]) .studio')!
        .hasAttribute('data-header'),
    );
    if (clear) await expectOverCover(page, '/@stylestage → /@styleclear');
    else {
      const h = await header(page);
      expect(h.background, 'clear: on its bg, not transparent').not.toBe(
        'rgba(0, 0, 0, 0)',
      );
      expect(h.scrim, 'clear: no scrim').toBe('none');
    }
    await expect(page.locator('.site-header .site-nav')).toBeHidden();
  });
});
