import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';

// The site header over the cover (owner, 18 Nov 2026: "this header should be transparent or blend
// into the theme on the hero"). Where a styled page starts with a full-bleed cover, the header sits
// over it, transparent, its words white on a soft scrim (over Signboard's band, the band's label
// colour); once the hero has scrolled past it is solid in the page's bg again. CSS only: a
// scroll-driven animation, which Chromium runs. Sprint's desktop keeps today's header (its photo is
// the left half, beside the name).

type Case = { style: string; label: string; query: string; band?: boolean };
const CASES: Case[] = [
  { style: 'stage', label: 'stage', query: 'style=stage&mode=light' },
  {
    style: 'stage',
    label: 'stage (gradient)',
    query: 'style=stage&mode=light&cover=gradient',
  },
  { style: 'horizon', label: 'horizon', query: 'style=horizon&mode=light' },
  { style: 'sprint', label: 'sprint', query: 'style=sprint&mode=light' },
  {
    style: 'signboard',
    label: 'signboard (band)',
    query: 'style=signboard&mode=light',
    band: true,
  },
  {
    style: 'signboard',
    label: 'signboard (photo)',
    query: 'style=signboard&mode=light&cover=yours',
  },
  { style: 'clear', label: 'clear (photo)', query: 'style=clear&mode=light' },
  {
    style: 'clear',
    label: 'clear (cover art)',
    query: 'style=clear&mode=light&yours=design',
  },
];

/**
 * A computed colour as rgb() and alpha. Chromium serialises color-mix() in srgb as
 * `color(srgb r g b / a)` with 0..1 channels.
 */
const rgba = (value: string) => {
  const css = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(value);
  if (css)
    return {
      rgb: `rgb(${css[1]}, ${css[2]}, ${css[3]})`,
      a: Number(css[4] ?? 1),
    };
  const srgb =
    /^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)$/.exec(value);
  if (!srgb) throw new Error(`not a colour: ${value}`);
  const [r, g, b] = [srgb[1], srgb[2], srgb[3]].map((c) =>
    Math.round(Number(c) * 255),
  );
  return { rgb: `rgb(${r}, ${g}, ${b})`, a: Number(srgb[4] ?? 1) };
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
      // The frosted glass past the hero: the header's own layer (::after).
      glass: (() => {
        const g = getComputedStyle(header, '::after');
        return {
          display: g.display,
          opacity: g.opacity,
          background: g.backgroundColor,
          blur: g.backdropFilter,
          line: `${g.borderBottomWidth} ${g.borderBottomStyle} ${g.borderBottomColor}`,
        };
      })(),
      line: resolve('--studio-line'),
    };
  });

// A phone, a tablet (the wide header's links over the cover; Sprint's cover still edge to edge)
// and a desktop.
for (const width of [390, 820, 1440])
  for (const { style, label, query, band } of CASES) {
    const name = `${label} at ${width}`;
    test(`the header sits over the cover at the top of ${name}, solid once past`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await page.goto(`/dev/studio-lab?${query}`);
      await page.locator('.studio[data-style]').waitFor();
      const top = await state(page);
      if (style === 'sprint' && width >= 1024) {
        // Desktop Sprint: today's header, solid in bg above the half-width photo.
        expect(top.background).toBe(top.bg);
        expect(top.heroTop).toBe(top.headerBottom);
        expect(top.wordmark).toBe('rgb(122, 50, 249)');
        expect(top.glass.display).toBe('none');
        await expectAccessible(page);
        return;
      }
      expect(top.background).toBe('rgba(0, 0, 0, 0)');
      expect(top.glass.opacity).toBe('0');
      // The cover runs up under the header.
      expect(top.heroTop).toBeLessThanOrEqual(0);
      expect(top.heroTop).toBeLessThanOrEqual(top.headerBottom);
      // White over the scrim, or the band's label colour; the wordmark in the same ink.
      const ink = band ? top.accLabel : 'rgb(255, 255, 255)';
      expect(top.color).toBe(ink);
      expect(top.wordmark).toBe(ink);
      // Every key and word ends where the unit test proves the scrim (72 px; the site's links
      // wrap to two lines on a tablet).
      expect(top.keysBottom).toBeLessThanOrEqual(72);
      if (width >= 801) {
        // "Claim your username" stays TipMe purple; over the band it has a ring in the band's
        // label colour, so its edge shows on a band as light as it.
        const claim = page.locator('.site-header .nav-claim');
        await expect(claim).toHaveCSS('background-color', 'rgb(122, 50, 249)');
        if (band)
          expect(
            await claim.evaluate((el) => getComputedStyle(el).boxShadow),
          ).toMatch(new RegExp(`^${esc(top.accLabel)} 0px 0px 0px 2px, `));
      }
      await expectAccessible(page);

      // Past the hero: frosted glass (the owner: "keep it fixed but kind of make it glassy when
      // you scroll"), today's words, the purple "me", still at the top of the screen. Read
      // together, once the scroll has been drawn.
      await page.evaluate((y) => window.scrollTo(0, y), top.heroBottom + 40);
      await expect
        .poll(async () => {
          const s = await state(page);
          return [s.background, s.color, s.wordmark, s.glass.opacity];
        })
        .toEqual(['rgba(0, 0, 0, 0)', top.fg, 'rgb(122, 50, 249)', '1']);
      const past = await state(page);
      expect(past.headerBottom).toBe(76);
      // The page's bg, translucent, over a blur, with a hairline in the page's line colour.
      expect(past.glass.blur).toMatch(/blur\(\d+px\)/);
      const glass = rgba(past.glass.background);
      expect(glass.a, past.glass.background).toBeLessThan(1);
      expect(glass.rgb).toBe(past.bg);
      // A hairline: 0.5 px, which a 1x screen draws as 1 px.
      expect(past.glass.line).toMatch(
        new RegExp(`^(0\\.5|1)px solid ${esc(past.line)}$`),
      );
      if (band && width >= 801)
        await expect
          .poll(() =>
            page
              .locator('.site-header .nav-claim')
              .evaluate((el) => getComputedStyle(el).boxShadow),
          )
          .toMatch(/^rgba\(0, 0, 0, 0\) 0px 0px 0px 2px, /);
      await expectAccessible(page);
    });
  }

// The sticky header covers the top 76 px: a Tip button scrolled under it is out of sight, so the
// phone's Tip bar shows (the bar's observer leaves the header's strip out of the screen).
for (const query of ['style=stage&mode=light', 'style=horizon&mode=light'])
  test(`the Tip bar shows once the in-page Tip is under the header (${query})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/dev/studio-lab?${query}`);
    const form = page.locator('form[data-skin]');
    await form.waitFor();
    await expect(form).toHaveAttribute('data-bar', 'hidden');
    const tip = form.locator('.composer-action .composer-submit');
    // The button's foot 12 px above the header's: wholly under the header, still in the window.
    await tip.evaluate((el) => {
      const box = el.getBoundingClientRect();
      window.scrollBy({ top: box.bottom - (76 - 12), behavior: 'instant' });
    });
    expect(
      await tip.evaluate((el) => Math.round(el.getBoundingClientRect().bottom)),
    ).toBe(64);
    await expect(form).toHaveAttribute('data-bar', 'shown');
    await expect(page.locator('.tip-bar')).toBeVisible();
  });

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
  const { heroBottom, fg } = await state(page);
  // Inside the change's range (the hero's foot 30 px under the header): no glass yet.
  await page.evaluate((y) => window.scrollTo(0, y), heroBottom - 76 - 30);
  await expect
    .poll(async () => (await state(page)).heroBottom)
    .toBe(heroBottom);
  const mid = await state(page);
  expect([mid.glass.opacity, mid.color]).toEqual(['0', 'rgb(255, 255, 255)']);
  // Once the hero has gone: the glass and today's words, at once.
  await page.evaluate((y) => window.scrollTo(0, y), heroBottom);
  await expect
    .poll(async () => {
      const s = await state(page);
      return [s.glass.opacity, s.color];
    })
    .toEqual(['1', fg]);
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

test('with reduced transparency asked for, the header past the hero is solid bg, not glass', async ({
  page,
}) => {
  // Chromium has no Playwright switch for it yet: the media feature, set through the protocol.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }],
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/dev/studio-lab?style=stage&mode=light');
  await page.locator('.studio[data-style]').waitFor();
  expect(
    await page.evaluate(
      () => matchMedia('(prefers-reduced-transparency: reduce)').matches,
    ),
  ).toBe(true);
  const { heroBottom, bg } = await state(page);
  await page.evaluate((y) => window.scrollTo(0, y), heroBottom + 40);
  await expect.poll(async () => (await state(page)).glass.opacity).toBe('1');
  const past = await state(page);
  expect(rgba(past.glass.background)).toEqual({ rgb: bg, a: 1 });
  expect(past.glass.blur).toBe('none');
});
