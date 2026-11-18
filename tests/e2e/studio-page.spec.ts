import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { settled } from './studio-probes';
import {
  API_COVER_PATH,
  COVER_KINDS,
  STUDIO_HANDLES,
  STYLE_HANDLES,
  STYLE_IDS,
  startStack,
  studioFixtures,
  type Stack,
  type StyleId,
} from './profile-fixtures';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// The public page renders a published Page Studio design in its style (styles spec §13): every
// style on its real /@username page, with TipMe's own tip form, footer and the site's header and
// footer around it, within the page's budgets. The fixtures run on the built web app against the
// stand-in API (profile-fixtures: /@style<id>, the board's three pages converted to v2); the switch
// itself runs on the full stack below.

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

/** The root a style renders: Classic is today's page with its attributes; the rest the frame. */
const rootOf = (page: Page, style: StyleId) =>
  page.locator(
    style === 'classic'
      ? 'main.profile-page--studio[data-style="classic"]'
      : `main.studio-main > .studio[data-style="${style}"]`,
  );

/** Elements matching `selector` that take up room on screen (one of a pair may be hidden by width). */
const shown = (page: Page, selector: string) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)].filter((el) => {
        const r = el.getBoundingClientRect();
        return (
          r.width > 0 &&
          r.height > 0 &&
          getComputedStyle(el).visibility !== 'hidden'
        );
      }).length,
    selector,
  );

test.describe('a published Studio page', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let stack: Stack;
  let studio: Awaited<ReturnType<typeof studioFixtures>>;
  test.beforeAll(async () => {
    studio = await studioFixtures();
    stack = await startStack('test');
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  test('every style renders on its public page with TipMe’s tip form and footer @mobile', async ({
    page,
  }) => {
    for (const style of STYLE_IDS) {
      const handle = `style${style}`;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${stack.origin}/@${handle}`);
      await expect(rootOf(page, style), handle).toBeVisible();
      await expect(page.locator('main'), handle).toHaveCount(1);
      await expect(
        page.getByRole('heading', { level: 1, name: 'Kemi Adeyinka' }),
        handle,
      ).toBeVisible();
      // TipMe's tip form, skinned by the style (Classic's is today's, with no skin).
      const form = page
        .locator('[data-tip-panel] form, .studio-tip form')
        .first();
      await expect(form, handle).toBeVisible();
      if (style === 'classic')
        await expect(form).not.toHaveAttribute('data-skin');
      else await expect(form).toHaveAttribute('data-skin', style);
      await expect(
        page.getByRole('button', { name: /^Tip\b/ }).first(),
        handle,
      ).toBeAttached();
      // The person's own blocks, in their order.
      await expect(
        page.getByText('Studio diary').filter({ visible: true }).first(),
        handle,
      ).toBeVisible();
      await expect(
        page
          .getByText(
            'The best night of live music I’ve had in Lagos this year.',
          )
          .filter({ visible: true })
          .first(),
      ).toBeVisible();
      const foot = page.locator('footer.profile-foot');
      await expect(foot.getByText('Report this page')).toBeVisible();
      await expect(foot.getByRole('link', { name: 'Privacy' })).toBeVisible();
      await expect(foot.getByRole('link', { name: 'Terms' })).toBeVisible();
      await expectAccessible(page);
      for (const width of [320, 390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await settled(page);
        expect(await fitsViewport(page), `${handle} at ${width}px`).toBe(true);
      }
    }
  });

  test('a styled page shows the site’s header and footer, blended; Classic keeps today’s', async ({
    page,
  }) => {
    for (const [handle, width] of [
      ['styleclear', 1440],
      ['stylestage', 1440],
      ['stylesprint', 390],
    ] as const) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${stack.origin}/@${handle}`);
      await page.locator('.studio[data-style]').waitFor();
      // Not the standard page's <main>: its rules hide the site's nav and footer.
      await expect(page.locator('main.profile-page')).toHaveCount(0);
      await expect(page.locator('body > .site-footer'), handle).toBeVisible();
      if (width === 1440)
        await expect(page.locator('.site-nav'), handle).toBeVisible();
      else
        await expect(
          page.getByRole('button', { name: 'Open menu' }),
          handle,
        ).toBeVisible();
      const c = await page.evaluate(() => {
        const studio = getComputedStyle(document.querySelector('.studio')!);
        const probe = document.createElement('i');
        probe.style.color = studio.getPropertyValue('--studio-bg');
        document.body.append(probe);
        const bg = getComputedStyle(probe).color;
        probe.remove();
        const css = (sel: string) =>
          getComputedStyle(document.querySelector(sel)!).backgroundColor;
        return {
          bg,
          header: css('.site-header'),
          footer: css('.site-footer'),
          html: css('html'),
          over: document.querySelector('.studio[data-header]') !== null,
        };
      });
      // A page that starts with a full-bleed cover has the header over it, transparent, until
      // the hero has scrolled past (studio-header-over-cover.spec.ts); the others run it on bg.
      if (c.over) {
        expect(c.header, handle).toBe('rgba(0, 0, 0, 0)');
        await page.evaluate(() =>
          window.scrollTo(0, document.documentElement.scrollHeight),
        );
        await expect(page.locator('.site-header'), handle).toHaveCSS(
          'background-color',
          c.bg,
        );
      } else expect(c.header, handle).toBe(c.bg);
      expect(c.footer, handle).toBe(c.bg);
      expect(c.html, handle).toBe(c.bg);
    }
    // Classic (and the standard page) keep today's: the nav and footer step aside.
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const handle of ['styleclassic', 'propage']) {
      await page.goto(`${stack.origin}/@${handle}`);
      await expect(page.locator('main.profile-page'), handle).toBeVisible();
      await expect(page.locator('.site-nav'), handle).toBeHidden();
      await expect(page.locator('body > .site-footer'), handle).toBeHidden();
    }
  });

  test('a styled page keeps one room for its Tip bar, not the standard page’s as well @mobile', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    for (const handle of ['styleclear', 'styletiles']) {
      await page.goto(`${stack.origin}/@${handle}`);
      await page.locator('form[data-skin]').waitFor();
      const pad = await page.evaluate(() => ({
        main: getComputedStyle(document.querySelector('main')!).paddingBottom,
        frame: parseFloat(
          getComputedStyle(document.querySelector('.studio-page')!)
            .paddingBottom,
        ),
        bar: parseFloat(
          document.documentElement.style.getPropertyValue('--tip-bar') || '136',
        ),
      }));
      expect(pad.main, handle).toBe('0px');
      // One reserve, the style's own (frame.css: the bar and a small gap; a style may add a
      // little), never the bar twice.
      expect(pad.frame, handle).toBeGreaterThanOrEqual(pad.bar);
      expect(pad.frame, handle).toBeLessThan(pad.bar + 40);
      // The bar waits while the Tip and the name are in view, and shows once they scroll away.
      const form = page.locator('form[data-skin]');
      await expect(form).toHaveAttribute('data-bar', 'hidden');
      await page.evaluate(() =>
        scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: 'instant',
        }),
      );
      await expect(form).toHaveAttribute('data-bar', 'shown');
      await expect(form.locator('.tip-bar')).toBeVisible();
    }
  });

  test('the update notice sits above the Tip bar on a styled page, as on Classic @mobile', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    // A newer build on the server: the open page offers a refresh (update-notice.spec.ts).
    await page.route('**/api/version', (route) =>
      route.fulfill({
        json: { version: 'a-newer-build' },
        headers: { 'cache-control': 'no-store' },
      }),
    );
    for (const [handle, bar] of [
      ['styleclear', 'form[data-skin] .tip-bar'],
      ['stylesprint', 'form[data-skin] .tip-bar'],
      ['styleclassic', '.profile-composer .composer-action'],
    ] as const) {
      await page.goto(`${stack.origin}/@${handle}`);
      const notice = page
        .getByRole('status')
        .filter({ hasText: 'TipMe has been updated.' });
      await expect
        .poll(async () => {
          await page.evaluate(() =>
            document.dispatchEvent(new Event('visibilitychange')),
          );
          return notice.isVisible();
        })
        .toBe(true);
      // Far down the page, where a styled page's bar is up.
      await page.evaluate(() =>
        scrollTo({
          top: document.documentElement.scrollHeight,
          behavior: 'instant',
        }),
      );
      await expect(page.locator(bar), handle).toBeVisible();
      await expect
        .poll(() =>
          page.evaluate((sel) => {
            const n = document
              .querySelector('.update-notice')!
              .getBoundingClientRect();
            const b = document.querySelector(sel)!.getBoundingClientRect();
            return Math.round(b.top - n.bottom);
          }, bar),
        )
        .toBeGreaterThanOrEqual(0);
    }
  });

  test('each style shows links once, in its place, and none without links', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const insta = 'a[href="https://www.instagram.com/kemisings"]';
    for (const style of STYLE_IDS) {
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`${stack.origin}/@style${style}`);
        await rootOf(page, style).waitFor();
        expect(await shown(page, `main ${insta}`), `${style} at ${width}`).toBe(
          1,
        );
        const area = style === 'classic' ? '.profile-links' : '.studio-links';
        await expect(page.locator(`${area} ${insta}`), style).toHaveCount(1);
        if (style !== 'classic')
          await expect(
            page
              .locator('.studio-links')
              .getByRole('heading', { name: 'Find me elsewhere' }),
          ).toBeVisible();
        if (width === 390) {
          // On a phone, after the name; after the Tip where the style puts them there (§8).
          const top = (sel: string) =>
            page
              .locator(sel)
              .first()
              .evaluate((el) => el.getBoundingClientRect().top);
          // The first link, not the area: a style's grid may lay the area out as contents.
          const link = `${area} ${insta}`;
          expect(await top(link), style).toBeGreaterThan(await top('h1'));
          if (studio.contracts.STUDIO_STYLES[style].linksAt === 'after-tip')
            expect(await top(link), style).toBeGreaterThan(
              await top('[data-tip-panel], .studio-tip'),
            );
        }
      }
      await page.goto(`${stack.origin}/@style${style}nolinks`);
      await rootOf(page, style).waitFor();
      await expect(
        page.locator('.studio-links, .profile-links'),
        style,
      ).toHaveCount(0);
      await expect(page.locator('main a[href*="instagram.com"]')).toHaveCount(
        0,
      );
      await expect(page.getByRole('link', { name: 'See links' })).toHaveCount(
        0,
      );
    }
  });

  test('Your cover renders each Settings cover kind', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const photo = 'img.studio-cover__photo';
    for (const kind of COVER_KINDS) {
      // Clear draws every kind in its cover slot.
      await page.goto(`${stack.origin}/@coverclear${kind}`);
      await page.locator('.studio[data-style="clear"]').waitFor();
      const slot = page.locator('.studio-cover').first();
      if (kind === 'photo' || kind === 'upload') {
        await expect(slot, kind).toHaveAttribute('data-cover', 'photo');
        await expect(slot.locator(photo)).toHaveAttribute(
          'fetchpriority',
          'high',
        );
      } else {
        await expect(slot, kind).toHaveAttribute('data-cover', 'art');
        await expect(slot.locator('.profile-cover')).toBeVisible();
        if (kind === 'animated')
          await expect(slot.locator('.profile-cover')).toHaveAttribute(
            'data-cover-play',
            /loop|once|still/,
          );
      }
      // Stage needs a photo: anything else is its gradient treatment (§13).
      await page.goto(`${stack.origin}/@coverstage${kind}`);
      await expect(page.locator('.studio-hero'), kind).toHaveAttribute(
        'data-cover',
        kind === 'photo' || kind === 'upload' ? 'photo' : 'gradient',
      );
    }
    // An uploaded cover: its renditions in srcset, then the full file (PR #279).
    await page.goto(`${stack.origin}/@coverclearupload`);
    const srcset = (await page.locator(photo).getAttribute('srcset')) ?? '';
    const base = `${API_ORIGIN}${API_COVER_PATH.replace(/\.webp$/, '')}`;
    expect(srcset).toBe(
      [640, 1080, 1600]
        .map((w) => `${base}-${w}.webp ${w}w`)
        .concat(`${base}.webp 2240w`)
        .join(', '),
    );
    // Today's page never uses them: the same cover on a page without a style.
    await page.goto(`${stack.origin}/@standardupload`);
    await expect(page.locator('.profile-columns')).toBeVisible();
    const standard = await page.evaluate(() =>
      [...document.querySelectorAll('img')]
        .map((i) => `${i.src} ${i.srcset}`)
        .join(' '),
    );
    expect(standard).not.toMatch(/-(640|1080|1600)\.webp/);
  });

  test('a lapsed Pro style shows Classic with their choices', async ({
    page,
  }) => {
    await page.goto(`${stack.origin}/@stylelapsed`);
    await expect(rootOf(page, 'classic')).toBeVisible();
    await expect(page.locator('.studio[data-style]')).toHaveCount(0);
    await expect(page.locator('.classic-blocks')).toContainText('Studio diary');
    // The gallery is Pro: hidden, and its photos not requested.
    await expect(page.locator('.classic-blocks img')).toHaveCount(0);
  });

  test('a profile without studio renders exactly today’s page', async ({
    page,
  }) => {
    // propage: a Pro page the API sends without a design (switch off, or nothing published).
    // studiofree: Pro extras only, sent for a Free page. classicplain: Classic with every
    // default. studiokemi/<ending>: a campaign link.
    for (const path of [
      '/@propage',
      '/@studiofree',
      '/@classicplain',
      '/@studiokemi/lekki',
    ]) {
      await page.goto(`${stack.origin}${path}`);
      await expect(page.locator('.profile-columns'), path).toBeVisible();
      await expect(page.locator('.studio'), path).toHaveCount(0);
      await expect(page.locator('[data-style]'), path).toHaveCount(0);
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

  test('Classic with every choice back at its default is byte for byte the page without a studio', async ({
    page,
  }) => {
    // Review Focus 4: the same person, one page with an all-default Classic design published and
    // one with none: the same HTML once the handle is the same, head and body, stylesheets, font
    // preloads and script files included. Only the inline flight data is set aside: it carries
    // timings from the request itself (milliseconds into it), so no two responses match there.
    const html = async (handle: string) =>
      (await (await page.request.get(`${stack.origin}/@${handle}`)).text())
        .replaceAll(handle, 'HANDLE')
        .replace(
          /<script>self\.__next_f\.push\([\s\S]*?<\/script>/g,
          '<script/>',
        );
    // Each once first: a page's first render after start orders its head differently.
    await html('classicplain');
    await html('classictwin');
    const [plain, twin] = [
      await html('classicplain'),
      await html('classictwin'),
    ];
    expect(plain).toContain('class="profile-page"');
    // The first difference, with some context, so a failure says where.
    let at = 0;
    while (at < plain.length && plain[at] === twin[at]) at += 1;
    expect(plain.slice(Math.max(0, at - 200), at + 200)).toBe(
      twin.slice(Math.max(0, at - 200), at + 200),
    );
    expect(plain).toBe(twin);
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
    await page
      .getByRole('button', { name: /^Play / })
      .first()
      .click();
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
    // At a phone's width and at the desktop default: a styled page shows the site's header
    // (ruling P), whose links must not prefetch other routes' script on a profile page.
    const script = async (
      path: string,
      viewport: { width: number; height: number },
    ) => {
      const context = await browser.newContext({ viewport });
      try {
        const loaded = await load(
          await context.newPage(),
          `${stack.origin}${path}`,
        );
        const scripts = loaded.filter((s) => s.type === 'script');
        return {
          bytes: total(scripts),
          files: new Map(
            scripts.map((s) => [new URL(s.url).pathname, s.bytes]),
          ),
        };
      } finally {
        await context.close();
      }
    };
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 1280, height: 720 },
    ]) {
      const standard = await script('/@propage', viewport);
      for (const handle of STYLE_HANDLES) {
        const designed = await script(`/@${handle}`, viewport);
        // The files only this page loads, so a failure says what grew.
        const own = [...designed.files].filter(([f]) => !standard.files.has(f));
        console.log(
          `STUDIO_SCRIPT ${JSON.stringify({ width: viewport.width, handle, designed: designed.bytes, standard: standard.bytes, own })}`,
        );
        expect(
          designed.bytes - standard.bytes,
          `${handle} at ${viewport.width}: ${designed.bytes} bytes of script; the standard page ${standard.bytes}`,
        ).toBeLessThanOrEqual(3 * 1024);
      }
    }
  });

  test('a page requests only its own font files (≤ 2 families), all from our origin', async ({
    page,
  }) => {
    for (const style of STYLE_IDS) {
      const handle = `style${style}`;
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
      const families = new Set(
        own.map((u) => /\/fonts\/studio\/([A-Za-z0-9]+)/.exec(u)![1]),
      );
      expect(families.size, handle).toBeLessThanOrEqual(2);
      expect(new Set(own).size, handle).toBeLessThanOrEqual(4);
      // Classic keeps today's fonts; every other style loads Studio Inter at least.
      if (style === 'classic') expect(own, handle).toEqual([]);
      else expect(families.size, handle).toBeGreaterThanOrEqual(1);
    }
  });

  test('measured first-load weight is within 15% of the design check’s estimate and under 1.5 MB', async ({
    browser,
  }) => {
    for (const handle of [...STUDIO_HANDLES, ...STYLE_HANDLES]) {
      const doc = studio.docs[handle]!;
      // A first load: a fresh context each time, so nothing comes from the cache.
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
      });
      const loaded = await load(
        await context.newPage(),
        `${stack.origin}/@${handle}`,
      ).finally(() => context.close());
      const measured = total(loaded);
      // The v3 estimate with the facts of the files this build serves: the lab's generated photos
      // (a few hundred bytes each, whatever the size) stand in for the API's. v3 scales one file
      // per photo to the rendition a slot loads, so each photo's file is sized to give back what
      // was served at the widest rendition seen.
      const photo = (url: string) =>
        /\/dev\/studio-lab\/image\/([0-9a-f-]{36})\/\w+-(\d+)$/.exec(url);
      const served = new Map<string, { bytes: number; width: number }>();
      for (const s of loaded) {
        const m = photo(s.url);
        if (!m) continue;
        const width = Number(m[2]);
        if ((served.get(m[1]!)?.width ?? 0) < width)
          served.set(m[1]!, { bytes: s.bytes, width });
      }
      const images = Object.fromEntries(
        [...served].map(([id, s]) => [
          id,
          {
            width: 2400,
            height: 1600,
            bytes: Math.round(s.bytes * (2400 / s.width) ** 2),
          },
        ]),
      );
      const estimate = studio.contracts.checkDesign(doc, {
        images,
        videos: {},
        profile: { name: 'Kemi Adeyinka', bio: true, links: 4 },
        plan: 'pro',
        coverKind: doc.style === 'classic' ? 'design' : 'photo',
        hasAvatar: false,
      }).weightBytes;
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
    // Twelve pages at two widths.
    test.setTimeout(360_000);
    for (const handle of [...STUDIO_HANDLES, ...STYLE_HANDLES])
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

// A v2 design (styles spec §5.2): Clear, two text blocks, the style's own accent.
const DESIGN = {
  v: 2,
  style: 'clear',
  accent: 'lagoon',
  mode: 'light',
  cover: 'yours',
  blocks: [
    {
      id: 'e2eblk01',
      kind: 'text',
      variant: 'heading',
      text: 'New single in December',
    },
    {
      id: 'e2eblk02',
      kind: 'text',
      variant: 'paragraph',
      text: 'Every tip goes into studio time for the next record.',
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
  // Signs up, publishes through the API, then waits for the cached page.
  test.setTimeout(90_000);
  const who = await signUpRecipient(page, testInfo);
  await publishDesign(page, who.handle);
  await expect(async () => {
    await page.goto(`/@${who.handle}`);
    await expect(page.locator('.studio[data-style="clear"]')).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(
    page.getByRole('heading', { name: 'New single in December' }),
  ).toBeVisible();
  await expect(page.locator('form[data-skin="clear"]')).toBeVisible();
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
