import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import {
  contrastProblems,
  geometryProblems,
  studioModules,
} from './studio-probes';

const BREAKPOINTS = [320, 390, 768, 1024, 1440] as const;

// Page Studio curated examples (plan Task 6): the board's three pages, the limits, and hostile
// text, each checked with axe, layout and contrast at every width; and the tip block identical on
// all of them, whatever the page's colours and fonts.

const EXAMPLES = [
  'kemi',
  'sule',
  'ify',
  'max',
  'min',
  'empty',
  'hostile',
] as const;

async function open(page: Page, query: string, width = 1440) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`/dev/studio-lab?${query}`);
  await page.locator('.studio').waitFor();
  await page.evaluate(() => document.fonts.ready);
}

for (const name of EXAMPLES)
  test(`example ${name}: axe, layout and contrast at every width`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await open(page, `example=${name}`);
    for (const width of BREAKPOINTS) {
      await page.setViewportSize({ width, height: 900 });
      expect(await geometryProblems(page), `${width}px`).toEqual([]);
      expect(await contrastProblems(page), `${width}px`).toEqual([]);
      await expectAccessible(page);
    }
  });

test('every library font sets its specimen cleanly, from our own origin only', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const origin = new URL(page.url() === 'about:blank' ? 'http://x' : page.url())
    .origin;
  const { STUDIO_FONTS } = (await studioModules()).contracts;
  for (const font of STUDIO_FONTS) {
    const requested: string[] = [];
    const listen = (r: { resourceType(): string; url(): string }) => {
      if (r.resourceType() === 'font') requested.push(r.url());
    };
    page.on('request', listen);
    await open(page, `example=fonts&font=${font.id}`, 390);
    page.off('request', listen);
    expect(await geometryProblems(page), font.id).toEqual([]);
    expect(await contrastProblems(page), font.id).toEqual([]);
    const studio = requested.filter((u) => u.includes('/fonts/studio/'));
    expect(studio.length, font.id).toBeGreaterThan(0);
    expect(
      new Set(
        studio.map((u) =>
          u
            .split('/')
            .pop()!
            .replace(/-\d.*$/, ''),
        ),
      ).size,
    ).toBeLessThanOrEqual(2);
    expect(
      requested.every(
        (u) =>
          !/^https?:/.test(u) ||
          new URL(u).origin === new URL(page.url()).origin,
      ),
      origin,
    ).toBe(true);
    const heading = page.locator('.studio-heading').first();
    await expect(heading).toHaveCSS(
      'font-family',
      new RegExp(`Studio ${font.name}|Studio Inter`),
    );
  }
});

test('the tip block is identical on every example', async ({ page }) => {
  test.setTimeout(120_000);
  const styles = async () =>
    page.locator('.studio-rail').evaluate((rail) =>
      [...rail.querySelectorAll('*')].map((el) => {
        const cs = getComputedStyle(el);
        return [
          el.tagName,
          cs.color,
          cs.backgroundColor,
          cs.fontFamily,
          cs.fontSize,
          cs.fontWeight,
          cs.borderTopColor,
        ].join(' ');
      }),
    );
  const seen: Record<string, string[]> = {};
  for (const name of ['kemi', 'sule', 'ify', 'hostile']) {
    await open(page, `example=${name}`);
    seen[name] = await styles();
  }
  expect(seen.kemi!.length).toBeGreaterThan(10);
  for (const name of ['sule', 'ify', 'hostile'])
    expect(seen[name], name).toEqual(seen.kemi);
  // TipMe's own fonts and colours: nothing of the page's design.
  await expect(page.locator('.studio-rail h2').first()).not.toHaveCSS(
    'font-family',
    /Studio/,
  );
});

test('the footer and its report link stay TipMe’s on a dark page', async ({
  page,
}) => {
  await open(page, 'example=kemi', 390);
  const foot = page.locator('.studio-foot');
  await expect(foot.getByRole('button', { name: /report/i })).toBeVisible();
  await expect(foot.getByRole('link', { name: 'Privacy' })).toBeVisible();
  await expect(foot).not.toHaveCSS('font-family', /Studio/);
});

test('a video loads nothing from its site until it is tapped @mobile', async ({
  page,
}) => {
  const outside: string[] = [];
  page.on('request', (r) => {
    if (
      /youtube|tiktok|audiomack|ytimg|googlevideo/.test(
        new URL(r.url()).hostname,
      )
    )
      outside.push(r.url());
  });
  // Never reach the real site: answer the embed with a blank page.
  await page.route(/youtube-nocookie\.com/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>video</title>',
    }),
  );
  await open(page, 'example=kemi', 360);
  expect(outside).toEqual([]);
  expect(await page.locator('iframe').count()).toBe(0);
  await page.getByRole('button', { name: /Play .*Lagos Rain/ }).click();
  await expect(page.locator('iframe.studio-video__frame')).toHaveAttribute(
    'src',
    /^https:\/\/www\.youtube-nocookie\.com\/embed\//,
  );
});
