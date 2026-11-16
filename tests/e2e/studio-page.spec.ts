import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import {
  STUDIO_HANDLES,
  startStack,
  studioFixtures,
  type Stack,
} from './profile-fixtures';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// The public page shows a published Page Studio design (plan Task 8): the person's rows around
// TipMe's own tip block, fee line, Pro badge, report link and footer, within the page budget. The
// three board examples run on the built web app against the stand-in API (profile-fixtures); the
// switch itself runs on the full stack.

const EXAMPLES = STUDIO_HANDLES;
/** The public page's frame-src: the allow-listed video sites (STUDIO_EMBED_ORIGINS). */
const FRAME_SRC =
  'frame-src https://www.youtube-nocookie.com https://www.tiktok.com https://audiomack.com';
const VIDEO_HOSTS = [
  'youtube.com',
  'youtube-nocookie.com',
  'ytimg.com',
  'tiktok.com',
  'audiomack.com',
];
const fromVideoSite = (url: string) =>
  VIDEO_HOSTS.some((host) => new URL(url).hostname.endsWith(host));

/** Bytes of every response the page took while loading, by type (body as sent, plus headers). */
async function load(page: Page, url: string) {
  const sizes: { url: string; type: string; bytes: number }[] = [];
  const done: Promise<void>[] = [];
  page.on('requestfinished', (request) =>
    done.push(
      request.sizes().then(
        (s) => {
          sizes.push({
            url: request.url(),
            type: request.resourceType(),
            bytes: s.responseBodySize + s.responseHeadersSize,
          });
        },
        () => undefined,
      ),
    ),
  );
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForLoadState('networkidle');
  await Promise.all(done);
  return sizes;
}
const total = (sizes: { bytes: number }[]) =>
  sizes.reduce((sum, s) => sum + s.bytes, 0);

test.describe('a published Studio page', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  let stack: Stack;
  let studio: Awaited<ReturnType<typeof studioFixtures>>;
  test.beforeAll(async () => {
    studio = await studioFixtures();
    stack = await startStack('test');
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  test('a Studio page keeps TipMe’s tip block, fee line, badge, report link and footer @mobile', async ({
    page,
  }) => {
    for (const handle of EXAMPLES) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${stack.origin}/@${handle}`);
      await expect(page.locator('.studio'), handle).toBeVisible();
      // TipMe's parts, inside the reset that keeps the person's colours and fonts out.
      const tip = page.locator('aside.studio-fixed.tip-instrument');
      await expect(tip).toHaveAttribute('aria-label', 'Tip Kemi');
      await expect(
        tip.getByRole('button', { name: /^Tip\b/ }),
        handle,
      ).toBeVisible();
      await expect(tip).toContainText(
        'No account needed. You pay exactly this amount.',
      );
      const foot = page.locator('.studio-fixed footer.profile-foot');
      await expect(foot.getByText('Report this page')).toBeVisible();
      await expect(foot.getByRole('link', { name: 'Privacy' })).toBeVisible();
      await expect(foot.getByRole('link', { name: 'Terms' })).toBeVisible();
      // Name, @username and the Pro badge at the top, in TipMe's identity block.
      const identity = page.locator('.studio-identity');
      await expect(identity.getByRole('heading', { level: 1 })).toHaveText(
        'Kemi Adeyinka',
      );
      await expect(identity).toContainText(`@${handle}`);
      await expect(identity.locator('.profile-identity__pro')).toBeVisible();
      // The person's own rows.
      await expect(
        page.locator('.studio-rows .studio-row').first(),
      ).toBeVisible();
      // A services block always ends with the fixed line (owner, 16 Nov 2026).
      for (const services of await page.locator('.studio-services').all())
        await expect(services.locator('.studio-fine')).toHaveText(
          'Prices are for information. Tips here are a gift, not a payment for a service.',
        );
      if (handle === 'studiosule')
        await expect(page.locator('.studio-services')).toHaveCount(1);
      // The site's own navigation steps aside, as on every public page.
      await expect(page.locator('.site-nav')).toBeHidden();
      // On a phone the tip block comes straight after the identity, before the rows.
      const order = await page.evaluate(() =>
        ['.studio-identity', '.studio-rail', '.studio-rows'].map(
          (s) => document.querySelector(s)!.getBoundingClientRect().top,
        ),
      );
      expect(order[0]).toBeLessThan(order[1]!);
      expect(order[1]).toBeLessThan(order[2]!);
      await expectAccessible(page);
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await fitsViewport(page), `${handle} at ${width}px`).toBe(true);
      }
    }
  });

  test('on a phone a Studio page has the standard page’s Tip bar and tip block @mobile', async ({
    page,
  }) => {
    // Owner, 16 Nov 2026: the same sticky Tip bar and tip block styling as the standard page.
    /** No overlap between the on-screen part of an element and the fixed Tip bar. */
    const clearOfBar = (selector: string) =>
      page.evaluate((target) => {
        const bar = document.querySelector('.composer-action')!;
        const element = document.querySelector(target)!;
        const a = bar.getBoundingClientRect();
        const b = element.getBoundingClientRect();
        const hidden = getComputedStyle(bar).visibility === 'hidden';
        return hidden || b.bottom <= a.top || b.top >= a.bottom;
      }, selector);
    const scrollTop = (top: number) =>
      page.evaluate((y) => scrollTo({ top: y, behavior: 'instant' }), top);
    for (const handle of EXAMPLES) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${stack.origin}/@${handle}`);
      const panel = page.locator('aside.studio-rail[data-tip-panel]');
      // The standard page's panel classes: its tip block styling and its Tip bar.
      await expect(panel, handle).toHaveClass(/\bprofile-composer\b/);
      await expect(panel.locator('.appreciation-card h2')).toHaveCSS(
        'font-family',
        /Iowan Old Style/,
      );
      const bar = panel.locator('.composer-action');
      await expect(bar, handle).toHaveCSS('position', 'fixed');
      // One action: the form's own submit button, in the bar.
      const tip = page.getByRole('button', { name: /^Tip\b/ });
      await expect(tip).toHaveCount(1);
      await expect(bar.getByRole('button', { name: /^Tip\b/ })).toHaveCount(1);
      // At the bottom of the screen, at the top of the page and far down it.
      for (const top of [0, 1500]) {
        await scrollTop(top);
        await expect(tip, `${handle} at ${top}`).toBeInViewport({ ratio: 1 });
        const box = await bar.boundingBox();
        expect(Math.round(box!.y + box!.height), handle).toBe(844);
      }
      // Out of the way while a field has focus, back after.
      await scrollTop(0);
      const other = panel.getByLabel(/^Other amount/);
      await other.fill('5');
      await expect(bar).toBeHidden();
      await other.blur();
      await expect(bar).toBeVisible();
      // Pressed from far down the page, Tip brings the tip block's problem into view, clear of
      // the bar.
      await scrollTop(100_000);
      await tip.click();
      const error = panel.getByText(/Enter an amount of NGN 2,000 or more/);
      await expect(error).toBeInViewport();
      await expect
        .poll(() => clearOfBar('.studio-rail .tm-field-error'))
        .toBe(true);
      // At the page's end, the Report link sits above the bar.
      await page.locator('.studio-rail .tm-input').first().blur();
      await scrollTop(100_000);
      await expect(bar).toBeVisible();
      await expect
        .poll(() => clearOfBar('.studio-foot .report-page'))
        .toBe(true);
      // Readable over the design: axe (contrast included) on the whole page, bar showing.
      await expectAccessible(page);
    }
    // An automatic design in a dark browser (the examples are light and dark): the bar and the
    // tip block keep TipMe's colours and pass too.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`${stack.origin}/@studiosule`);
    await page
      .locator('.studio')
      .evaluate((studio) => studio.setAttribute('data-mode', 'auto'));
    await expect(page.locator('.studio')).toHaveCSS('color-scheme', 'dark');
    await expect(page.locator('.composer-action')).toBeVisible();
    await expectAccessible(page);
  });

  test('a profile without studio renders exactly today’s page', async ({
    page,
  }) => {
    // propage: a Pro page the API sends without a design (switch off, or nothing published).
    // studiofree: a design sent for a Free page. studiokemi/<ending>: a campaign link.
    for (const path of ['/@propage', '/@studiofree', '/@studiokemi/lekki']) {
      await page.goto(`${stack.origin}${path}`);
      await expect(page.locator('.profile-columns'), path).toBeVisible();
      await expect(page.locator('.studio'), path).toHaveCount(0);
      await expect(
        page.locator(
          '.profile-columns > aside.profile-composer.tip-instrument',
        ),
      ).toBeVisible();
      // Next.js links the Studio stylesheet with the route: none of its rules may touch this page.
      const touched = await page.evaluate(() => {
        const found: string[] = [];
        const walk = (rules: CSSRuleList) => {
          for (const rule of rules) {
            if (rule instanceof CSSStyleRule) {
              const plain = rule.selectorText.replace(
                /::?[\w-]+(\([^)]*\))?/g,
                '',
              );
              if (
                /studio/.test(rule.selectorText) &&
                plain &&
                document.querySelector(plain)
              )
                found.push(rule.selectorText);
            } else if ('cssRules' in rule)
              walk((rule as CSSGroupingRule).cssRules);
          }
        };
        for (const sheet of document.styleSheets)
          try {
            walk(sheet.cssRules);
          } catch {
            // Another origin's sheet: there is none on this page.
          }
        return found;
      });
      expect(touched, `${path}: Studio rules that match`).toEqual([]);
      expect(
        await page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .some((r) => r.name.includes('/fonts/studio/')),
        ),
        `${path} loads a Studio font`,
      ).toBe(false);
    }
    const headers = (
      await page.request.get(`${stack.origin}/@propage`)
    ).headers();
    expect(headers['content-security-policy']).toContain(FRAME_SRC);
  });

  test('nothing loads from a video site before the tap', async ({ page }) => {
    const seen: string[] = [];
    page.on('request', (r) => fromVideoSite(r.url()) && seen.push(r.url()));
    // Never reach the real site from a test: the frame's request is answered here.
    await page.route(
      (url) => fromVideoSite(url.toString()),
      (route) => route.fulfill({ status: 200, body: '<!doctype html>' }),
    );
    await page.goto(`${stack.origin}/@studiokemi`);
    await page.waitForLoadState('networkidle');
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('link')].map((l) => l.href),
      ),
    ).not.toContainEqual(expect.stringMatching(/youtube|tiktok|audiomack/));
    expect(seen).toEqual([]);
    await page.getByRole('button', { name: /^Play / }).click();
    await expect(page.locator('iframe.studio-video__frame')).toHaveAttribute(
      'src',
      /^https:\/\/www\.youtube-nocookie\.com\/embed\//,
    );
    await expect.poll(() => seen.length).toBeGreaterThan(0);
    // The public page may frame exactly the allow-listed sites; the rest of the site none.
    const csp = async (path: string) =>
      (await page.request.get(`${stack.origin}${path}`)).headers()[
        'content-security-policy'
      ] ?? '';
    expect(await csp('/@studiokemi')).toContain(`${FRAME_SRC};`);
    expect(FRAME_SRC).toBe(
      `frame-src ${studio.contracts.STUDIO_EMBED_ORIGINS.join(' ')}`,
    );
    for (const path of ['/', '/@studiokemi/lekki', '/legal/terms'])
      expect(await csp(path), path).not.toContain('frame-src');
  });

  test('a Studio page ships at most 3 KB more script than the standard page', async ({
    browser,
  }) => {
    // Each page in a fresh context, so every script it needs is counted, none from the cache.
    const script = async (path: string) => {
      const context = await browser.newContext();
      try {
        const loaded = await load(
          await context.newPage(),
          `${stack.origin}${path}`,
        );
        return total(loaded.filter((s) => s.type === 'script'));
      } finally {
        await context.close();
      }
    };
    const standard = await script('/@propage');
    for (const handle of EXAMPLES) {
      const designed = await script(`/@${handle}`);
      console.log(
        `STUDIO_SCRIPT ${JSON.stringify({ handle, designed, standard })}`,
      );
      expect(
        designed - standard,
        `${handle}: ${designed} bytes of script; the standard page ${standard}`,
      ).toBeLessThanOrEqual(3 * 1024);
    }
  });

  test('a page requests only its own font files (≤ 2 families), all from our origin', async ({
    page,
  }) => {
    for (const handle of EXAMPLES) {
      const fonts: string[] = [];
      const listen = (r: { resourceType(): string; url(): string }) =>
        r.resourceType() === 'font' && fonts.push(r.url());
      page.on('request', listen);
      await page.goto(`${stack.origin}/@${handle}`);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForLoadState('networkidle');
      page.off('request', listen);
      expect(
        fonts.every((u) => u.startsWith(stack.origin)),
        handle,
      ).toBe(true);
      const own = fonts.filter((u) => u.includes('/fonts/studio/'));
      const doc = studio.docs[handle];
      const families = new Set(
        own.map((u) => /\/fonts\/studio\/([A-Za-z0-9]+)/.exec(u)![1]),
      );
      expect(families.size, handle).toBeLessThanOrEqual(2);
      expect(families.size, handle).toBe(
        doc.fonts.heading === doc.fonts.body ? 1 : 2,
      );
      expect(new Set(own).size, handle).toBeLessThanOrEqual(4);
    }
  });

  test('measured first-load weight is within 15% of the design check’s estimate and under 1.5 MB', async ({
    browser,
  }) => {
    for (const handle of EXAMPLES) {
      const doc = studio.docs[handle];
      // A first load: a fresh context each time, so nothing comes from the cache.
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      });
      const loaded = await load(
        await context.newPage(),
        `${stack.origin}/@${handle}`,
      ).finally(() => context.close());
      const measured = total(loaded);
      // The check's estimate with the facts of the files this build serves: the lab's generated
      // photos (a few hundred bytes each, whatever the size) stand in for the API's, so each
      // rendition counts at its served size instead of the examples' guess for a real photo.
      const photo = (url: string) =>
        /\/dev\/studio-lab\/image\/([0-9a-f-]{36})\/(\w+-\d+)$/.exec(url);
      const served = new Map<string, number>();
      for (const s of loaded) {
        const m = photo(s.url);
        if (m) served.set(`${m[1]}/${m[2]}`, s.bytes);
      }
      const typical = Math.max(0, ...served.values());
      const images = structuredClone(studio.context.images) as Record<
        string,
        { width: number; height: number; bytes: Record<string, number> }
      >;
      for (const [id, image] of Object.entries(images))
        for (const key of Object.keys(image.bytes))
          image.bytes[key] = served.get(`${id}/${key}`) ?? typical;
      const estimate = studio.contracts.studioWeight(doc, {
        ...studio.context,
        images,
        profile: { bio: true, links: 4 },
      }).bytes;
      console.log(
        `STUDIO_WEIGHT ${JSON.stringify({ handle, measured, estimate })}`,
      );
      expect(measured, handle).toBeLessThan(
        studio.contracts.STUDIO_WEIGHT.budget,
      );
      expect(
        Math.abs(measured - estimate) / measured,
        `${handle}: measured ${measured} bytes, estimated ${estimate}`,
      ).toBeLessThanOrEqual(0.15);
    }
  });

  test('CLS during font swap stays ≤ 0.05', async ({ page }) => {
    for (const handle of EXAMPLES)
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${stack.origin}/@${handle}`);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(500);
        const cls = await page.evaluate(
          () =>
            new Promise<number>((resolve) => {
              let sum = 0;
              new PerformanceObserver((list) => {
                for (const e of list.getEntries() as (PerformanceEntry & {
                  value: number;
                  hadRecentInput: boolean;
                })[])
                  if (!e.hadRecentInput) sum += e.value;
              }).observe({ type: 'layout-shift', buffered: true });
              setTimeout(() => resolve(sum), 200);
            }),
        );
        expect(cls, `${handle} at ${width}px`).toBeLessThanOrEqual(0.05);
      }
  });
});

// The full stack: a Pro page publishes a design through the API, and the `page_studio` switch
// (on in the e2e stack, off in production) decides whether the public page shows it.

const DESIGN = {
  v: 1,
  brand: ['#0f766e'],
  mode: 'light',
  fonts: { heading: 'fraunces', body: 'inter' },
  scale: 'standard',
  corners: 'soft',
  rows: [
    {
      id: 'e2erow01',
      columns: '1',
      spacing: 'm',
      background: 'page',
      cells: [
        [
          {
            id: 'e2eblk01',
            kind: 'text',
            variant: 'heading',
            level: 2,
            text: 'New single in December',
          },
          {
            id: 'e2eblk02',
            kind: 'text',
            variant: 'paragraph',
            text: 'Every tip goes into studio time for the next record.',
          },
        ],
      ],
    },
  ],
};

async function publishDesign(page: Page, handle: string) {
  await sql(
    `UPDATE profiles SET staff_pro = true, plan = 'pro' WHERE handle_lower = $1`,
    [handle],
  );
  const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };
  const mine = await page.request.get(`${API_ORIGIN}/v1/me/studio`);
  expect(mine.status()).toBe(200);
  const saved = await page.request.put(`${API_ORIGIN}/v1/me/studio/draft`, {
    headers,
    data: { rev: (await mine.json()).data.rev, draft: DESIGN },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  const published = await page.request.post(
    `${API_ORIGIN}/v1/me/studio/publish`,
    { headers, data: { rev: (await saved.json()).data.rev } },
  );
  expect(published.status(), await published.text()).toBe(200);
}

test('with the switch on, a Pro page’s published design is its public page', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo);
  await publishDesign(page, who.handle);
  await expect(async () => {
    await page.goto(`/@${who.handle}`);
    await expect(page.locator('.studio')).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: 'New single in December' }),
  ).toBeVisible();
  await expect(page.locator('aside.studio-fixed.tip-instrument')).toBeVisible();
});

// @alone: the switch changes every page, so nothing may run beside it.
test('@alone with the switch off, the same page is the standard page; on again, the design is back', async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const who = await signUpRecipient(page, testInfo);
  await publishDesign(page, who.handle);
  const shows = (studio: boolean) =>
    expect(async () => {
      await page.goto(`/@${who.handle}`);
      await expect(page.locator('.studio')).toHaveCount(studio ? 1 : 0, {
        timeout: 1000,
      });
      await expect(page.locator('.profile-columns')).toHaveCount(
        studio ? 0 : 1,
        { timeout: 1000 },
      );
    }).toPass({ timeout: 100_000, intervals: [2000] });
  await shows(true);
  try {
    // Off, as staff set it in admin (written directly). The API reads the switch within 15
    // seconds, and a cached page follows within about 30 more.
    await sql(
      `INSERT INTO feature_switches (key, enabled, source, changed_at, reason)
       VALUES ('page_studio', false, 'staff', now(), 'e2e: the public page without Page Studio')
       ON CONFLICT (key) DO UPDATE SET enabled = false, source = 'staff'`,
    );
    await shows(false);
  } finally {
    // Back to the lane's seed (PAGE_STUDIO_ENABLED in playwright.config.ts): on.
    await sql(`DELETE FROM feature_switches WHERE key = 'page_studio'`);
  }
  await shows(true);
});
