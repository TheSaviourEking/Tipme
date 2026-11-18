import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';

// The site header over the cover (owner, 18 Nov 2026: "this header should be transparent or blend
// into the theme on the hero"). Where a styled page starts with a full-bleed cover, the header sits
// over it, transparent, its words white on a soft scrim (over Signboard's band, the band's label
// colour); once the hero has scrolled past it is solid in the page's bg again. CSS only: a
// scroll-driven animation, which Chromium runs. Sprint's desktop keeps today's header (its photo is
// the left half, beside the name).

type Case = { style: string; query: string; band?: boolean };
const CASES: Case[] = [
  { style: 'stage', query: 'style=stage&mode=light' },
  { style: 'horizon', query: 'style=horizon&mode=light' },
  { style: 'sprint', query: 'style=sprint&mode=light' },
  { style: 'signboard', query: 'style=signboard&mode=light', band: true },
  { style: 'signboard', query: 'style=signboard&mode=light&cover=yours' },
];

/** The page's tokens as the browser resolves colours, and the header and hero as drawn. */
const state = (page: Page) =>
  page.evaluate(() => {
    const studio = document.querySelector('.studio')!;
    const resolve = (name: string) => {
      const probe = document.createElement('i');
      probe.style.color = getComputedStyle(studio).getPropertyValue(name);
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    const header = document.querySelector('.site-header')!;
    // The page's first full-bleed part (a page that starts on bg has none: 0).
    const hero = document.querySelector(
      '.studio-page > :is(.studio-hero, .studio-cover:not([data-cover="plain"]), .studio-band)',
    );
    const box = hero?.getBoundingClientRect() ?? { top: 0, bottom: 0 };
    // The header bar's own keys and words (the closed phone menu's are not drawn).
    const keys = [
      ...header.querySelectorAll<HTMLElement>(
        '.nav-shell > .brand, .nav-shell > .menu-toggle, .site-nav > a, .who__button',
      ),
    ].filter((el) => el.getClientRects().length > 0);
    return {
      bg: resolve('--studio-bg'),
      fg: resolve('--studio-fg'),
      accLabel: resolve('--studio-accLabel'),
      background: getComputedStyle(header).backgroundColor,
      color: getComputedStyle(header).color,
      headerBottom: header.getBoundingClientRect().bottom,
      heroTop: box.top,
      heroBottom: box.bottom + scrollY,
      keysBottom: Math.max(
        ...keys.map((k) => k.getBoundingClientRect().bottom),
      ),
      wordmark: getComputedStyle(
        header.querySelector('.nav-shell > .brand path[fill="#7A32F9"]')!,
      ).fill,
    };
  });

for (const width of [390, 1440])
  for (const { style, query, band } of CASES) {
    const name = `${style}${band ? ' (band)' : query.includes('yours') ? ' (photo)' : ''} at ${width}`;
    test(`the header sits over the cover at the top of ${name}, solid once past`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`/dev/studio-lab?${query}`);
      await page.locator('.studio[data-style]').waitFor();
      const top = await state(page);
      if (style === 'sprint' && width === 1440) {
        // Desktop Sprint: today's header, solid in bg above the half-width photo.
        expect(top.background).toBe(top.bg);
        expect(top.heroTop).toBe(top.headerBottom);
        expect(top.wordmark).toBe('rgb(122, 50, 249)');
        await expectAccessible(page);
        return;
      }
      expect(top.background).toBe('rgba(0, 0, 0, 0)');
      // The cover runs up under the header.
      expect(top.heroTop).toBeLessThanOrEqual(0);
      expect(top.heroTop).toBeLessThanOrEqual(top.headerBottom);
      // White over the scrim, or the band's label colour; the wordmark in the same ink.
      const ink = band ? top.accLabel : 'rgb(255, 255, 255)';
      expect(top.color).toBe(ink);
      expect(top.wordmark).toBe(ink);
      // Every key and word ends where the unit test proves the scrim (64 px).
      expect(top.keysBottom).toBeLessThanOrEqual(64);
      if (width === 1440)
        // "Claim your username" stays TipMe purple.
        await expect(page.locator('.site-header .nav-claim')).toHaveCSS(
          'background-color',
          'rgb(122, 50, 249)',
        );
      await expectAccessible(page);

      // Past the hero: the page's bg and words, and still at the top of the screen.
      await page.evaluate((y) => window.scrollTo(0, y), top.heroBottom + 40);
      await expect
        .poll(async () => (await state(page)).background)
        .toBe(top.bg);
      const past = await state(page);
      expect(past.color).toBe(past.fg);
      // Today's header again: the purple "me".
      expect(past.wordmark).toBe('rgb(122, 50, 249)');
      expect(past.headerBottom).toBe(76);
      await expectAccessible(page);
    });
  }

test('the phone menu opened over a cover is the solid page panel, in the page’s words', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dev/studio-lab?style=horizon&mode=light');
  await page.locator('.studio[data-style]').waitFor();
  const { bg, fg } = await state(page);
  await page.getByRole('button', { name: 'Open menu' }).click();
  const menu = page.locator('.site-nav.is-open');
  await expect(menu).toHaveCSS('background-color', bg);
  await expect(menu.getByRole('link', { name: 'How it works' })).toHaveCSS(
    'color',
    fg,
  );
  await expect(menu.getByRole('link', { name: 'Sign in' })).toHaveCSS(
    'color',
    fg,
  );
  await expect(menu.locator('.nav-claim')).toHaveCSS(
    'background-color',
    'rgb(122, 50, 249)',
  );
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
});

test('focus rings on the header keys show over the cover and on bg', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dev/studio-lab?style=stage&mode=light');
  await page.locator('.studio[data-style]').waitFor();
  const link = page.locator('.site-nav > a', { hasText: 'How it works' });
  await link.focus();
  await expect(link).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
  const { heroBottom, fg } = await state(page);
  await page.evaluate((y) => window.scrollTo(0, y), heroBottom + 40);
  await expect(link).toHaveCSS('outline-color', fg);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  const toggle = page.getByRole('button', { name: 'Open menu' });
  await toggle.focus();
  await expect(toggle).toHaveCSS('outline-color', 'rgb(255, 255, 255)');
  await expect(toggle).toHaveCSS('outline-style', 'solid');
});

test('with reduced motion the header switches once the hero is gone, with no fade', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dev/studio-lab?style=stage&mode=light');
  await page.locator('.studio[data-style]').waitFor();
  const { heroBottom, bg } = await state(page);
  // Inside the fade's range (the hero's foot 30 px under the header): still transparent.
  await page.evaluate((y) => window.scrollTo(0, y), heroBottom - 76 - 30);
  await expect
    .poll(async () => (await state(page)).heroBottom)
    .toBe(heroBottom);
  expect((await state(page)).background).toBe('rgba(0, 0, 0, 0)');
  await page.evaluate((y) => window.scrollTo(0, y), heroBottom);
  await expect.poll(async () => (await state(page)).background).toBe(bg);
});

test('pages that start on bg, Classic and pages without a style keep today’s header', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const query of [
    'style=journal&mode=light',
    'style=linen&mode=light',
    'style=tiles&mode=light',
    'style=clear&mode=light&cover=gradient',
    'style=horizon&mode=light&cover=gradient',
  ]) {
    await page.goto(`/dev/studio-lab?${query}`);
    await page.locator('.studio[data-style]').waitFor();
    expect(await page.locator('[data-header]').count(), query).toBe(0);
    const s = await state(page);
    expect(s.background, query).toBe(s.bg);
    await expect(page.locator('.site-header'), query).toHaveCSS(
      'position',
      'relative',
    );
  }
  // Classic with choices, and a profile with no style: the site's own header, as today.
  await page.goto('/dev/studio-lab?style=classic&mode=dark&accent=green');
  await page.locator('[data-style="classic"]').waitFor();
  await expect(page.locator('.site-header')).toHaveCSS('position', 'relative');
  expect(await page.locator('[data-header]').count()).toBe(0);
  await page.goto('/@tobi');
  await expect(page.locator('.site-header')).toHaveCSS('position', 'relative');
  await expect(page.locator('.site-header')).toHaveCSS(
    'background-color',
    'rgb(243, 242, 238)',
  );
  expect(await page.locator('[data-header]').count()).toBe(0);
});
