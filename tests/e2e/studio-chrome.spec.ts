import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';

// The site's header and footer on a styled page (owner, 17 Nov 2026, ruling P): they take the
// page's own neutrals, so nothing sits on the site's paper as a separate band. The header runs
// into the page on its `bg`, the footer card is `card`, words are `fg`/`fg2`; on a tip page the
// header is the logo alone (owner, 19 Nov 2026). A page without a style keeps today's header and
// footer.

const colours = (page: Page) =>
  page.evaluate(() => {
    const studio = getComputedStyle(document.querySelector('.studio')!);
    const css = (sel: string, prop: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).getPropertyValue(prop) : null;
    };
    // A token as the browser resolves a colour, so it compares with computed backgrounds.
    const resolve = (name: string) => {
      const probe = document.createElement('i');
      probe.style.color = studio.getPropertyValue(name);
      document.body.append(probe);
      const value = getComputedStyle(probe).color;
      probe.remove();
      return value;
    };
    return {
      bg: resolve('--studio-bg'),
      card: resolve('--studio-card'),
      fg: resolve('--studio-fg'),
      header: css('.site-header', 'background-color'),
      html: css('html', 'background-color'),
      footer: css('.site-footer', 'background-color'),
      footerCard: css('.footer-card', 'background-color'),
      wordmark: css('.site-header .brand__mark path', 'fill'),
    };
  });

for (const width of [390, 1440])
  for (const mode of ['light', 'dark'] as const)
    test(`the header and footer blend into a styled page at ${width}, ${mode}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      // Clear on its gradient starts on the page's own bg (a photo cover puts the header over
      // the cover: studio-header-over-cover.spec.ts).
      await page.goto(
        `/dev/studio-lab?style=clear&mode=${mode}&cover=gradient`,
      );
      await page.locator('.studio[data-style]').waitFor();
      const c = await colours(page);
      expect(c.header).toBe(c.bg);
      expect(c.html).toBe(c.bg);
      expect(c.footer).toBe(c.bg);
      expect(c.footerCard).toBe(c.card);
      // The wordmark's "tip" is the page's text colour, so it reads in dark too.
      expect(c.wordmark).toBe(c.fg);
      // On a tip page (the lab stands in for one) the header is the logo alone (owner, 19 Nov
      // 2026): no menu, keys or phone menu button to colour.
      const header = page.locator('.site-header');
      await expect(header.getByRole('link')).toHaveCount(1);
      await expect(header.getByRole('button')).toHaveCount(0);
      await expectAccessible(page);
    });

test('a page without a style keeps the site header and footer exactly', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/legal/terms');
  // tokens.css: --canvas #f3f2ee, --surface-raised #fffefa, the wordmark's black.
  await expect(page.locator('.site-header')).toHaveCSS(
    'background-color',
    'rgb(243, 242, 238)',
  );
  await expect(page.locator('.site-footer')).toHaveCSS(
    'background-color',
    'rgb(243, 242, 238)',
  );
  await expect(
    page.locator('.site-header .brand__mark path').first(),
  ).toHaveCSS('fill', 'rgb(0, 0, 0)');
  expect(
    await page
      .locator('.footer-card')
      .evaluate((el) => getComputedStyle(el).backgroundColor),
  ).toBe('rgb(255, 254, 250)');
  await page.goto('/@tobi');
  await expect(page.locator('.site-header')).toHaveCSS(
    'background-color',
    'rgb(243, 242, 238)',
  );
});
