import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { fitsViewport, signUpRecipient } from './helpers';
import { makePagePro } from './ops-helpers';
import {
  LONG_NAME,
  UNBROKEN_NAME,
  UNBROKEN_ROLE,
  startStack,
  type Mode,
  type Stack,
} from './profile-fixtures';
import { CONNECTION_COPY } from '../../apps/web/src/lib/connection-copy';

// The public page (spec section 5). Test mode runs on the full e2e stack. The other payment states
// and the worst-case pages run the same built web app against a stand-in API (profile-fixtures).

const TRUST = 'No account needed. You pay exactly this amount.';
const LIVE_LINE = 'You pay exactly this. You’ll confirm on our partner’s page.';
const openDetails = (page: Page) =>
  page.getByText('Add a message, reason or your name').click();
const tipButton = (page: Page) => page.getByRole('button', { name: /^Tip\b/ });
const share = (page: Page) =>
  page.getByRole('button', { name: 'Share this page' });
const makeYourOwn = (page: Page) =>
  page.getByRole('link', { name: 'Get your own TipMe page' });

/** Each check at desktop width and on a phone. */
const both = (
  name: string,
  body: (args: { page: Page }, info: TestInfo) => Promise<void>,
) => {
  test(name, ({ page }, info) => body({ page }, info));
  test(`${name} @mobile`, ({ page }, info) => body({ page }, info));
};

const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
async function expectAccessible(page: Page, label: string) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(wcag)
    .analyze();
  expect(
    violations.map(
      ({ id, nodes }) =>
        `${label} ${id}: ${nodes.map((n) => n.target.join(' ')).join(', ')}`,
    ),
  ).toEqual([]);
}

const box = async (page: Page, selector: string) => {
  await page.locator(selector).first().waitFor();
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} is not rendered`);
  return found;
};

/**
 * The text that sticks out sideways, if any (empty is a pass). The document width alone can't
 * say: `main` clips overflowing content (`overflow-x: clip`), so a cut-off line leaves
 * `scrollWidth` untouched. Every piece of visible text is measured where it is actually drawn.
 */
const overflowing = (page: Page) =>
  page.evaluate(() => {
    const found: string[] = [];
    if (document.documentElement.scrollWidth > innerWidth)
      found.push('the document scrolls sideways');
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
    );
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !node.textContent?.trim()) continue;
      if (parent.closest('script, style, [hidden], [aria-hidden="true"]'))
        continue;
      if (getComputedStyle(parent).visibility === 'hidden') continue;
      // The body of a closed disclosure keeps its boxes but is not drawn.
      const closed = parent.closest('details:not([open])');
      if (closed && !parent.closest('summary')) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects())
        // Tiny boxes are visually hidden text (screen-reader only), not drawn.
        if (rect.width > 1 && rect.height > 1 && rect.right > innerWidth + 0.5)
          found.push(
            `${parent.tagName.toLowerCase()}.${parent.className} reaches ${Math.round(rect.right)} of ${innerWidth}: ${node.textContent.trim().slice(0, 30)}`,
          );
    }
    return found;
  });
/** No overlap between the on-screen part of an element and the fixed Tip bar. */
const clearOfBar = (page: Page, selector: string) =>
  page.evaluate((target) => {
    const bar = document.querySelector('.composer-action');
    const element = document.querySelector(target);
    if (!bar || !element) throw new Error(`missing ${target}`);
    const a = bar.getBoundingClientRect();
    const b = element.getBoundingClientRect();
    const hidden = getComputedStyle(bar).visibility === 'hidden';
    return hidden || b.bottom <= a.top || b.top >= a.bottom;
  }, selector);

both(
  'the page shows only the logo above the cover, with no nav, sign-in or breadcrumb',
  async ({ page }) => {
    await page.goto('/@ada');
    await expect(page.getByRole('link', { name: 'TipMe home' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Menu' })).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Home', exact: true }),
    ).toHaveCount(0);
    const logo = await box(page, '.site-header .brand');
    const cover = await box(page, '[data-profile-cover]');
    expect(logo.y + logo.height).toBeLessThanOrEqual(cover.y + 1);
    // The site's own footer goes, on this page only; the legal links stay in the page's own.
    await expect(page.locator('.site-footer')).toBeHidden();
  },
);

both(
  'other pages keep the site navigation and footer',
  async ({ page }, info) => {
    for (const path of ['/', '/for-creators', '/@not-a-person']) {
      await page.goto(path);
      if (info.project.name === 'mobile')
        await expect(page.getByRole('button', { name: 'Menu' })).toBeVisible();
      else
        await expect(
          page.getByRole('link', { name: 'Sign in' }).first(),
        ).toBeVisible();
      await expect(
        page.getByRole('navigation', { name: 'Footer navigation' }),
      ).toBeVisible();
    }
  },
);

both(
  'the name is the h1 and "Support Great People" is gone',
  async ({ page }) => {
    await page.goto('/@ada');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'Ada Okafor',
    );
    await expect(page.getByText('Support Great People')).toHaveCount(0);
    await expect(page.getByText('A simpler, more thoughtful way')).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('heading', { level: 2, name: 'Tip Ada' }),
    ).toBeVisible();
  },
);

test.describe('the page in each payment state', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  const stacks = new Map<string, Stack>();
  const at = async (
    mode: Mode,
    path: string,
    page: Page,
    options: { pilotNotice?: boolean } = {},
  ) => {
    const key = `${mode}${options.pilotNotice ? '+pilot' : ''}`;
    let stack = stacks.get(key);
    if (!stack) {
      stack = await startStack(mode, options);
      stacks.set(key, stack);
    }
    await page.goto(`${stack.origin}${path}`);
    // The loading silhouette has been swapped for the page.
    await page.getByRole('heading', { level: 1 }).waitFor();
    return stack.origin;
  };
  test.afterAll(async () => {
    await Promise.all([...stacks.values()].map((s) => s.stop()));
  });

  both(
    'the profile photo appears once, with links inside the identity block',
    async ({ page }, info) => {
      await at('live', '/@kemi', page);
      const identity = page.locator('[data-profile-card]');
      // Each link shows its handle and is named for its site.
      const list = identity.getByRole('list', { name: 'Find Kemi elsewhere' });
      for (const site of ['Facebook', 'Instagram', 'X'])
        await expect(
          list.getByRole('link', {
            name: `${site}: @kemi (opens in a new tab)`,
            exact: true,
          }),
        ).toBeVisible();
      await expect(list.getByRole('link').first()).toHaveAttribute(
        'target',
        '_blank',
      );
      await expect(list.locator('.link-badge')).toHaveText(['f', 'IG', 'X']);
      const contact = identity.getByRole('list', { name: 'Contact Kemi' });
      for (const name of ['+2348000000000', 'kemi@example.com'])
        await expect(
          contact.getByRole('link', { name, exact: true }),
        ).toBeVisible();
      await expect(contact.locator('svg')).toHaveCount(2);
      const links = await identity
        .getByRole('link')
        .evaluateAll((all) => all.map((a) => a.getBoundingClientRect().height));
      for (const height of links) expect(height).toBeGreaterThanOrEqual(44);

      // Initials stand in for the missing photo, once, in the circle over the cover's edge.
      await expect(page.locator('.profile-photo')).toHaveCount(1);
      const photo = await box(page, '.profile-photo');
      const cover = await box(page, '[data-profile-cover]');
      expect(photo.y).toBeLessThan(cover.y + cover.height);
      expect(photo.y + photo.height).toBeGreaterThan(cover.y + cover.height);
      const size = info.project.name === 'mobile' ? 104 : 144;
      expect(photo.width).toBe(size);
      expect(photo.height).toBe(size);
      // The ring sits on any cover, so it is the solid canvas colour.
      const ring = await page.locator('.profile-photo').evaluate((el) => {
        const style = getComputedStyle(el);
        return [
          style.borderTopColor,
          parseFloat(style.borderTopWidth),
          getComputedStyle(document.querySelector('.profile-page')!)
            .backgroundColor,
        ] as const;
      });
      expect(ring[0]).toBe(ring[2]);
      expect(ring[0]).toMatch(/^rgb\(/);
      expect(ring[1]).toBeGreaterThanOrEqual(4);
    },
  );

  both('no text on the page says demo', async ({ page }) => {
    for (const [mode, path] of [
      ['test', '/@kemi'],
      ['live', '/@kemi'],
      ['closed', '/@kemi'],
    ] as const) {
      await at(mode, path, page);
      expect(await page.locator('body').innerText()).not.toMatch(/demo/i);
      await expect(
        page.locator('main [alt*="demo" i], main [aria-label*="demo" i]'),
      ).toHaveCount(0);
    }
  });

  both(
    'closed checkout shows no Tip button, and offers Copy page link',
    async ({ page }, info) => {
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      const origin = await at('closed', '/@kemi', page);
      await expect(
        page.getByRole('heading', { name: 'Tipping opens soon' }),
      ).toBeVisible();
      await expect(tipButton(page)).toHaveCount(0);
      await expect(page.locator('.composer-action')).toHaveCount(0);
      await expect(page.getByText(TRUST)).toHaveCount(0);
      // ScreenSmall: it names the page, and the way on is to claim one's own.
      await expect(
        page.getByRole('heading', {
          name: /^Tipping opens soon on .+’s page\.$/,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', { name: 'Claim your username' }),
      ).toHaveAttribute('href', '/sign-up');
      const copy = page.getByRole('button', { name: 'Copy page link' });
      const before = await copy.boundingBox();
      await copy.click();
      await expect(page.getByText('Link copied.').first()).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `${origin}/@kemi`,
      );
      // The button keeps its width, and goes back after two seconds.
      expect(
        (await page.locator('.share-profile--text button').boundingBox())
          ?.width,
      ).toBe(before?.width);
      await expect(
        page.getByRole('button', { name: 'Copy page link' }),
      ).toBeVisible({ timeout: 4000 });
      if (info.project.name === 'mobile')
        await expect(page.locator('.profile-page')).not.toHaveCSS(
          'padding-bottom',
          /^(8|9)\dpx/,
        );
    },
  );

  both(
    'live payments for named pages: a page not on the list shows Tipping opens soon, with no pay button',
    async ({ page }) => {
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write']);
      const origin = await at('live', '/@unlisted', page, {
        pilotNotice: true,
      });
      await expect(
        page.getByRole('heading', { name: 'Tipping opens soon' }),
      ).toBeVisible();
      // No amounts, no Tip button or bar, no trust line, and no pilot notice: nothing here moves money.
      await expect(tipButton(page)).toHaveCount(0);
      await expect(page.getByRole('radio')).toHaveCount(0);
      await expect(page.locator('.composer-action')).toHaveCount(0);
      await expect(page.getByText(TRUST)).toHaveCount(0);
      await expect(page.getByTestId('pilot-notice')).toHaveCount(0);
      // The page itself still reads as the person's, and can be passed on.
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Kemi Bello',
      );
      await page.getByRole('button', { name: 'Copy page link' }).click();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        `${origin}/@unlisted`,
      );
      expect(await page.locator('body').innerText()).not.toMatch(/bachs|demo/i);
      expect(await overflowing(page)).toEqual([]);
      await expectAccessible(page, 'live unlisted page');
      // A page on the list, on the same copy, takes tips.
      await at('live', '/@kemi', page, { pilotNotice: true });
      await expect(tipButton(page)).toBeVisible();
      await expect(
        page.getByRole('heading', { name: 'Tipping opens soon' }),
      ).toHaveCount(0);
    },
  );

  both(
    'the pilot notice sits with the Tip button on the redesigned page, in live mode only',
    async ({ page }) => {
      await at('live', '/@kemi', page, { pilotNotice: true });
      const panel = page.locator('[data-tip-panel]');
      const tip = panel.getByRole('button', { name: /^Tip/ });
      await expect(tip).toBeVisible();
      // Shown once on the page, in the tip panel, never in the footer.
      await expect(page.getByTestId('pilot-notice')).toHaveCount(1);
      await expect(panel.getByTestId('pilot-notice')).toContainText(
        'TipMe is in a pilot. Payments are real.',
      );
      await expect(
        panel.getByRole('link', { name: 'support@usetipme.xyz' }),
      ).toHaveAttribute('href', 'mailto:support@usetipme.xyz');
      await expect(
        page.locator('footer [data-testid=pilot-notice]'),
      ).toHaveCount(0);
      // On a phone the Tip button is in the fixed bar, with the same words directly above it;
      // elsewhere the notice is the line under the button.
      const bar = page.locator('.composer-action__notice');
      const tipBox = (await tip.boundingBox())!;
      if (await bar.isVisible()) {
        await expect(bar).toContainText(
          'TipMe is in a pilot. Payments are real.',
        );
        const barBox = (await bar.boundingBox())!;
        expect(barBox.y + barBox.height).toBeLessThanOrEqual(tipBox.y);
        expect(tipBox.y - (barBox.y + barBox.height)).toBeLessThan(40);
      } else {
        const noticeBox = (await panel
          .getByTestId('pilot-notice')
          .boundingBox())!;
        expect(noticeBox.y).toBeGreaterThan(tipBox.y);
        expect(noticeBox.y - (tipBox.y + tipBox.height)).toBeLessThan(80);
      }
      // One copy to the eye and one to a screen reader, on a phone (the bar's) and elsewhere (the
      // line under the button): the words, and the help link, are each there once.
      await expect(
        page
          .getByText('TipMe is in a pilot. Payments are real.')
          .locator('visible=true'),
      ).toHaveCount(1);
      const heard = await panel.ariaSnapshot();
      expect(
        heard.split('TipMe is in a pilot. Payments are real.').length - 1,
      ).toBe(1);
      expect(heard.split('link "support@usetipme.xyz"').length - 1).toBe(1);
      expect(await page.locator('body').innerText()).not.toMatch(/bachs/i);
      // Not live (test mode, or closed): the setting is on but there is nothing real to warn about.
      for (const mode of ['test', 'closed'] as const) {
        await at(mode, '/@kemi', page, { pilotNotice: true });
        await expect(page.getByTestId('pilot-notice')).toHaveCount(0);
      }
    },
  );

  both('Pro pages hide "Get your own TipMe page"', async ({ page }) => {
    await at('live', '/@kemi', page);
    await expect(makeYourOwn(page)).toHaveAttribute('href', '/sign-up');
    await expect(
      page.getByRole('button', { name: 'Report this page' }),
    ).toBeVisible();
    await at('live', '/@propage', page);
    await expect(makeYourOwn(page)).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Report this page' }),
    ).toBeVisible();
  });

  both(
    'a 60-character name or role, 280-character bio, and no photo, role or links all hold at 320px',
    async ({ page }) => {
      await page.setViewportSize({ width: 320, height: 700 });
      await at('live', '/@longname', page);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        LONG_NAME,
      );
      expect(await overflowing(page)).toEqual([]);
      const name = await box(page, 'h1');
      const shareButton = await share(page).boundingBox();
      expect(name.x + name.width).toBeLessThanOrEqual(320);
      expect(shareButton?.width).toBe(44);
      expect(shareButton?.height).toBe(44);
      await at('live', '/@widename', page);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        UNBROKEN_NAME,
      );
      expect(await overflowing(page)).toEqual([]);
      await at('live', '/@widerole', page);
      await expect(page.locator('.profile-role')).toHaveText(UNBROKEN_ROLE);
      expect(await overflowing(page)).toEqual([]);
      const role = await box(page, '.profile-role');
      expect(role.x + role.width).toBeLessThanOrEqual(320);
      await at('live', '/@bareface', page);
      expect(await overflowing(page)).toEqual([]);
      await expect(page.locator('.profile-photo')).toHaveText('NE');
      await expect(page.getByRole('list', { name: /elsewhere/ })).toHaveCount(
        0,
      );
      await expect(page.locator('.profile-role, .profile-bio')).toHaveCount(0);
    },
  );

  both(
    'axe finds nothing on phone and desktop, in every payment state',
    async ({ page }) => {
      for (const [mode, path] of [
        ['test', '/@kemi'],
        ['live', '/@kemi'],
        ['live', '/@waiting'],
        ['live', '/@bareface'],
        ['live', '/@hearts'],
        ['closed', '/@kemi'],
      ] as const) {
        await at(mode, path, page);
        await page.waitForTimeout(350);
        await expectAccessible(page, `${mode} ${path}`);
      }
    },
  );

  both(
    'links: a Pro page’s featured key leads the row; an older API’s links still show',
    async ({ page }) => {
      await at('live', '/@prolinks', page);
      const identity = page.locator('[data-profile-card]');
      const featured = identity.getByRole('link', {
        name: 'Watch me live on Twitch @kemi (opens in a new tab)',
        exact: true,
      });
      await expect(featured).toHaveAttribute('href', 'https://twitch.tv/kemi');
      const list = identity.getByRole('list', { name: 'Find Kemi elsewhere' });
      const named = async (
        links: ReturnType<Page['getByRole']>,
        names: string[],
      ) => {
        await expect(links).toHaveCount(names.length);
        for (const [i, name] of names.entries())
          await expect(links.nth(i)).toHaveAccessibleName(name);
      };
      await named(list.getByRole('link'), [
        'TikTok: @kemi.cuts (opens in a new tab)',
        'Website: kemicuts.com (opens in a new tab)',
      ]);
      await expect(list.locator('.link-badge')).toHaveText(['TT', 'www']);
      await expect(list.getByRole('link').last()).toHaveAttribute(
        'rel',
        'noopener noreferrer nofollow ugc',
      );
      const key = await featured.boundingBox();
      const row = await list.boundingBox();
      expect(key!.y + key!.height).toBeLessThanOrEqual(row!.y);
      expect(key!.height).toBeGreaterThanOrEqual(44);
      expect(await overflowing(page)).toEqual([]);
      await expectAccessible(page, 'prolinks');

      await at('live', '/@oldlinks', page);
      await named(
        page
          .getByRole('list', { name: 'Find Kemi elsewhere' })
          .getByRole('link'),
        [
          'Instagram: @kemi (opens in a new tab)',
          'X: @kemi (opens in a new tab)',
        ],
      );
    },
  );

  both(
    'the cover is decorative, server-rendered, holds its space and does not hold up the largest paint',
    async ({ page }) => {
      const origin = await at('live', '/@kemi', page);
      const html = await (await page.request.get(`${origin}/@kemi`)).text();
      expect(html).toContain('data-profile-cover="image"');
      expect(html).toMatch(
        /<img[^>]*alt=""[^>]*fetchPriority="high"|<img[^>]*fetchPriority="high"[^>]*alt=""/i,
      );
      expect(html).toMatch(/<h1[^>]*>Kemi Bello<\/h1>/);
      await expect(page.locator('[data-profile-cover] img')).toHaveAttribute(
        'alt',
        '',
      );

      // Slow the picture down: nothing below it may move when it arrives.
      await page.addInitScript(() => {
        const w = window as unknown as {
          __cls: number;
          __lcp: { name: string; at: number }[];
        };
        w.__cls = 0;
        w.__lcp = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as {
            value: number;
          }[])
            w.__cls += entry.value;
        }).observe({ type: 'layout-shift', buffered: true });
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as unknown as {
            element?: Element;
            startTime: number;
          }[])
            w.__lcp.push({
              name: entry.element?.closest('[data-profile-cover]')
                ? 'cover'
                : (entry.element?.tagName ?? ''),
              at: entry.startTime,
            });
        }).observe({ type: 'largest-contentful-paint', buffered: true });
      });
      let release = () => {};
      const held = new Promise<void>((done) => (release = done));
      await page.route('**/_next/image**covers**', async (route) => {
        await held;
        await route.continue();
      });
      await page.goto(`${origin}/@kemi`, { waitUntil: 'commit' });
      const name = await box(page, 'h1');
      const frame = await box(page, '[data-profile-cover]');
      release();
      await expect
        .poll(() =>
          page
            .locator('[data-profile-cover] img')
            .evaluate(
              (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
            ),
        )
        .toBe(true);
      await page.waitForTimeout(300);
      expect((await box(page, 'h1')).y).toBe(name.y);
      expect((await box(page, '[data-profile-cover]')).height).toBe(
        frame.height,
      );
      const seen = await page.evaluate(() => {
        const w = window as unknown as {
          __cls: number;
          __lcp: { name: string; at: number }[];
        };
        return { cls: w.__cls, lcp: w.__lcp };
      });
      expect(seen.cls).toBeLessThan(0.01);
      const largest = seen.lcp.at(-1);
      expect(['cover', 'H1']).toContain(largest?.name);
    },
  );

  test('the largest paint arrives with the cover or name, with no animation holding it', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const origin = await at('live', '/@hearts', page);
    await page.goto(`${origin}/@hearts`);
    const moving = await page.evaluate(() =>
      document.getAnimations().flatMap((a) => {
        const target = (a.effect as KeyframeEffect | null)?.target;
        return target?.closest('[data-profile-cover], [data-profile-card]')
          ? [target.tagName]
          : [];
      }),
    );
    expect(moving).toEqual([]);
  });

  test("on a wide screen the panel overlaps the cover's lower right and stays in view", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 980 });
    await at('live', '/@kemi', page);
    const cover = await box(page, '[data-profile-cover]');
    const panel = await box(page, '[data-tip-panel]');
    const identity = await box(page, '[data-profile-card]');
    expect(cover.width).toBe(1120);
    expect(panel.y).toBeLessThan(cover.y + cover.height);
    expect(panel.y).toBeGreaterThan(cover.y);
    expect(panel.x + panel.width).toBeLessThanOrEqual(
      cover.x + cover.width + 1,
    );
    expect(panel.x).toBeGreaterThan(identity.x + identity.width - 1);
    await expect(page.locator('[data-tip-panel]')).toHaveCSS(
      'position',
      'sticky',
    );
    // Live mode says it in one line beside the Tip key (public-boards PR 9).
    const line = page
      .locator('[data-tip-panel] .composer-action__partner')
      .getByText(LIVE_LINE);
    await expect(line).toBeVisible();
    await expect(page.getByText(TRUST)).toHaveCount(0);
    await expect(tipButton(page)).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    // Space for the live pilot notice: the wording stays directly under the button.
    const button = await tipButton(page).boundingBox();
    const trust = await line.boundingBox();
    expect(trust?.y).toBeGreaterThanOrEqual(
      (button?.y ?? 0) + (button?.height ?? 0),
    );
  });

  test('the panel rises in, without moving the fixed Tip bar on a phone', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await at('live', '/@kemi', page);
    await expect(page.locator('[data-tip-panel]')).toHaveCSS(
      'animation-name',
      /profile-panel-rise/,
    );
    await expect(page.locator('[data-tip-panel]')).toHaveCSS(
      'animation-duration',
      '0.24s',
    );
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator('[data-tip-panel]')).toHaveCSS(
      'animation-name',
      /profile-panel-fade/,
    );
  });
});

test('Copy page link copies the page link and says Link copied.', async ({
  page,
  context,
  baseURL,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/@ada');
  await share(page).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Link copied.' }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    `${baseURL}/@ada`,
  );
  await expect(
    page.getByRole('status').filter({ hasText: 'Link copied.' }),
  ).toHaveCount(0, { timeout: 4000 });
});

test('Copy page link says so when the browser refuses @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('no')) },
    });
  });
  await share(page).click();
  await expect(page.getByText(/Copy is unavailable/)).toBeVisible();
  expect(await overflowing(page)).toEqual([]);
});

test('on a phone the Tip button stays in view and the form still works @mobile', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('/@ada');
  // One action: a single accessible button, the form's own.
  await expect(tipButton(page)).toHaveCount(1);
  await expect(
    page.locator('form:has(.composer-action) button[type="submit"]'),
  ).toHaveCount(1);
  const viewport = page.viewportSize()!;
  const inView = async () => {
    const found = await tipButton(page).boundingBox();
    expect(found!.y).toBeGreaterThanOrEqual(0);
    expect(found!.y + found!.height).toBeLessThanOrEqual(viewport.height);
  };
  await inView();
  await page.evaluate(() => scrollTo({ top: 500, behavior: 'instant' }));
  await inView();
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await expect(tipButton(page)).toHaveText(/^Tip ₦2,000/);
  await inView();
  // Nothing moves while it starts: only the button's busy state.
  await page.route('**/v1/tip-intents', async (route) => {
    await new Promise((done) => setTimeout(done, 400));
    await route.continue();
  });
  // The panel's entrance can still be playing on a slow machine: only what starting does counts.
  await page
    .locator('.profile-composer')
    .evaluate((panel) =>
      Promise.all(panel.getAnimations().map((a) => a.finished)),
    );
  await tipButton(page).click();
  await expect(
    page.getByRole('button', { name: /Starting your tip/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .filter((a) => a.playState === 'running')
        .map((a) => {
          const target = (a.effect as KeyframeEffect | null)?.target;
          return `${target?.tagName}.${target?.className}: ${(a as CSSTransition).transitionProperty ?? (a as CSSAnimation).animationName}`;
        }),
    ),
  ).toEqual([]);
  await page.waitForURL(/mock-checkout|\/tip\//);
});

test('the Tip bar never covers a focused field, an error or the Report link @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  const bar = page.locator('.composer-action');
  // Tapping Tip with a missing amount (the page starts on 2,000, so choose Other and leave it
  // empty): the error is shown clear of the bar.
  await page.getByLabel(/^Other amount/).fill('5');
  await page.getByLabel(/^Other amount/).blur();
  await tipButton(page).click();
  const error = page.getByText(/Enter an amount of NGN 2,000 or more/);
  await expect(error).toBeVisible();
  await expect
    .poll(() => clearOfBar(page, '.appreciation-card .tm-field-error'))
    .toBe(true);
  await expect(error).toBeInViewport();

  // Each field: the bar is out of the way while it has focus, and back after.
  await page.getByLabel(/^Other amount/).blur();
  await openDetails(page);
  const message = page.getByLabel('Personal message (optional)');
  await message.focus();
  await expect(bar).toBeHidden();
  await expect(tipButton(page)).toHaveCount(0);
  await message.blur();
  await expect(bar).toBeVisible();

  // Keyboard users: anything focused by Tab is scrolled clear of the bar.
  await page.getByRole('radio', { name: '5,000 NGN' }).focus();
  await expect.poll(() => clearOfBar(page, '.tm-amount-choice')).toBe(true);
  await page.locator('.composer-extras summary').focus();
  await expect
    .poll(() => clearOfBar(page, '.composer-extras summary'))
    .toBe(true);

  // Back at the page's end, the Report link sits above the bar.
  await page
    .getByRole('button', { name: 'Report this page' })
    .scrollIntoViewIfNeeded();
  await page.evaluate(() =>
    scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
  );
  await expect
    .poll(() => clearOfBar(page, '.profile-foot .report-page'))
    .toBe(true);
  const report = await page
    .getByRole('button', { name: 'Report this page' })
    .boundingBox();
  const barBox = await bar.boundingBox();
  expect(report!.y + report!.height).toBeLessThanOrEqual(barBox!.y);

  // Opening the report form hides nothing, and its field has the bar out of the way too.
  await page.getByRole('button', { name: 'Report this page' }).click();
  const reason = page.getByLabel('What’s wrong with this page?');
  await reason.focus();
  await expect(bar).toBeVisible();
  await expect.poll(() => clearOfBar(page, '.profile-foot select')).toBe(true);
  await reason.blur();
});

test('closing the phone keyboard with a field still focused brings the Tip bar back @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  await openDetails(page);
  const field = page.getByLabel('Personal message (optional)');
  await field.focus();
  await page.setViewportSize({ width: 360, height: 500 });
  await expect(page.locator('.composer-action')).toBeHidden();
  // CSS hides the bar at once, but the page hears of the resize on a later frame. A real keyboard
  // never opens and closes within one, so let it hear about the smaller screen first.
  await page.evaluate(
    () =>
      new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done)),
      ),
  );
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator('.composer-action')).toBeVisible();
  await expect(field).not.toBeFocused();
});

test('a failed start is shown clear of the Tip bar @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await page.route('**/v1/tip-intents', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'x' },
      }),
    }),
  );
  await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
  await tipButton(page).click();
  const notice = page.locator('.appreciation-card .tm-slip');
  await expect(notice).toBeInViewport();
  await expect
    .poll(() => clearOfBar(page, '.appreciation-card .tm-slip'))
    .toBe(true);
});

test('the trust line stays in the card on a phone, and the partner wording beside Tip @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  await expect(page.locator('.composer-trust')).toHaveText(TRUST);
  await expect(page.locator('.composer-action__partner')).toContainText(
    'our payment partner',
  );
});

test('a Pro page loses "Get your own TipMe page" within seconds of staff changing the plan', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const { handle } = await signUpRecipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(makeYourOwn(visitor)).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await makePagePro(browser, handle, testInfo);
  // Inside the 30-second backstop: the change itself refreshed the cached page.
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(makeYourOwn(visitor)).toHaveCount(0, { timeout: 500 });
  }).toPass({ timeout: 10_000 });
});

// The owner, 3 Nov 2026: a Pro badge "we'd display on our user's page when they subscribed to pro".
test('a Pro page wears the Pro badge beside the name, and a Free page none', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const { handle } = await signUpRecipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  const badge = visitor.locator('.profile-identity__name .tm-pro-badge');
  await visitor.goto(`/@${handle}`);
  await expect(visitor.locator('#profile-name')).toBeVisible();
  await expect(badge).toHaveCount(0);
  await makePagePro(browser, handle, testInfo);
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(badge).toHaveText('Pro', { timeout: 500 });
  }).toPass({ timeout: 10_000 });
  // Beside the name, not inside the heading: the page is still called by the person's name.
  await expect(visitor.getByRole('heading', { level: 1 })).not.toContainText(
    'Pro',
  );
});

test('choosing a reason keeps the Tip bar: a select opens no keyboard @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  await openDetails(page);
  const reason = page.getByLabel('What is this tip for? (optional)');
  await reason.focus();
  await reason.selectOption({ index: 1 });
  await expect(reason).toBeFocused();
  await expect(page.locator('.composer-action')).toBeVisible();
  await expect(tipButton(page)).toBeVisible();
  await expect.poll(() => clearOfBar(page, 'select')).toBe(true);
});

test('the bar names the amount, with no total line @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  // Keys just clear of the bar, as a thumb would have them.
  await page.evaluate(() => {
    const keys = document.querySelector('.amount-options')!;
    const bar = document.querySelector('.composer-action')!;
    scrollBy({
      top:
        keys.getBoundingClientRect().bottom -
        bar.getBoundingClientRect().top +
        4,
      behavior: 'instant',
    });
  });
  await page.getByRole('radio', { name: '5,000 NGN' }).click();
  await expect(tipButton(page)).toHaveText(/^Tip ₦5,000/);
  await expect(tipButton(page)).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.tip-payment-total')).toHaveCount(0);
  // Small on a phone: notice, partner line and button together.
  const bar = await page.locator('.composer-action').boundingBox();
  expect(bar!.height).toBeLessThanOrEqual(140);
  // The Report link still clears the bar at the page's end.
  await page.evaluate(() =>
    scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
  );
  await expect.poll(() => clearOfBar(page, '.profile-foot')).toBe(true);
});

const WORDS = 'TipMe is in test mode: no real money moves yet.';
/** How many times the words are in what a screen reader is given for the tip panel. */
const heardTimes = async (page: Page) =>
  (await page.locator('[data-tip-panel]').ariaSnapshot()).split(WORDS).length -
  1;

test('on a phone the mode wording is shown once, in the bar directly above the button, and heard once @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  const slot = page.locator('.composer-action .composer-action__notice');
  await expect(slot).toHaveText(WORDS);
  await expect(slot).toBeInViewport({ ratio: 1 });
  const notice = await slot.boundingBox();
  const button = await tipButton(page).boundingBox();
  expect(notice!.y + notice!.height).toBeLessThanOrEqual(button!.y);
  // The copy under the button is gone from sight and from the accessibility tree: one copy only.
  await expect(page.locator('.composer-disclaimer__mode')).toBeHidden();
  await expect(page.getByText(WORDS).locator('visible=true')).toHaveCount(1);
  expect(await heardTimes(page)).toBe(1);
});

test('at desktop width the bar copy stays out: the wording sits under the button, seen and heard once', async ({
  page,
}) => {
  await page.goto('/@ada');
  await expect(page.locator('.composer-action__notice')).toBeHidden();
  await expect(page.locator('.composer-disclaimer__mode')).toHaveText(WORDS);
  await expect(page.locator('.composer-disclaimer__mode')).toBeVisible();
  expect(await heardTimes(page)).toBe(1);
});

test('with no notice to show, the bar has no empty slot @mobile', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const stack = await startStack('live');
  try {
    await page.goto(`${stack.origin}/@kemi`);
    await page.getByRole('heading', { level: 1 }).waitFor();
    await expect(page.locator('.composer-action__notice')).toHaveCount(0);
  } finally {
    await stack.stop();
  }
});

test('at 1280x720 the Tip button is in view, and choosing moves nothing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/@ada');
  const button = tipButton(page);
  await expect(button).toBeInViewport({ ratio: 1 });
  const before = await button.boundingBox();
  await page.getByRole('radio', { name: '5,000 NGN' }).click();
  await expect(button).toHaveText(/^Tip ₦5,000/);
  await expect(button).toBeInViewport({ ratio: 1 });
  expect((await button.boundingBox())!.y).toBe(before!.y);
});

// Older browsers ignore the whole block: simulated by removing it, and every :has() rule.
test('without :has() the button simply stays in the form @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.getByRole('heading', { level: 1 }).waitFor();
  const removed = await page.evaluate(() => {
    let supports = 0;
    const walk = (list: {
      cssRules: CSSRuleList;
      deleteRule(i: number): void;
    }) => {
      for (let i = list.cssRules.length - 1; i >= 0; i -= 1) {
        const rule = list.cssRules[i]!;
        if (
          rule instanceof CSSSupportsRule &&
          rule.conditionText.includes(':has')
        ) {
          list.deleteRule(i);
          supports += 1;
        } else if (
          rule instanceof CSSStyleRule &&
          rule.selectorText.includes(':has(')
        )
          list.deleteRule(i);
        else if (rule instanceof CSSGroupingRule) walk(rule);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet);
    return supports;
  });
  expect(removed).toBeGreaterThan(0);
  await expect(page.locator('.composer-action')).toHaveCSS(
    'position',
    'static',
  );
  await expect(page.locator('.composer-action__notice')).toBeHidden();
  await openDetails(page);
  await page.getByLabel('Personal message (optional)').focus();
  await expect(tipButton(page)).toBeVisible();
});

both(
  'Privacy and Terms are reachable, and clear of the bar',
  async ({ page }) => {
    await page.goto('/@ada');
    const foot = page.locator('.profile-foot');
    await expect(foot.getByRole('link', { name: 'Privacy' })).toHaveAttribute(
      'href',
      '/legal/privacy',
    );
    await expect(foot.getByRole('link', { name: 'Terms' })).toHaveAttribute(
      'href',
      '/legal/terms',
    );
    await page.evaluate(() =>
      scrollTo({ top: document.body.scrollHeight, behavior: 'instant' }),
    );
    const bar = await page.locator('.composer-action').boundingBox();
    const link = await foot.getByRole('link', { name: 'Terms' }).boundingBox();
    if (
      (bar?.y ?? 0) + (bar?.height ?? 0) === page.viewportSize()!.height &&
      bar!.width === page.viewportSize()!.width
    )
      expect(link!.y + link!.height).toBeLessThanOrEqual(bar!.y);
  },
);

test.describe('the page without scripts, and its status codes', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  let stack: Stack;
  test.beforeAll(async () => {
    stack = await startStack('live');
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  both(
    'the person and the form are in the HTML, with scripts off',
    async ({ page }) => {
      const context = await page
        .context()
        .browser()!
        .newContext({ javaScriptEnabled: false });
      const noJs = await context.newPage();
      const response = await noJs.goto(`${stack.origin}/@kemi`);
      expect(response?.status()).toBe(200);
      await expect(noJs.getByRole('heading', { level: 1 })).toHaveText(
        'Kemi Bello',
      );
      await expect(noJs.locator('.tm-skeleton')).toHaveCount(0);
      await expect(noJs.locator('.profile-photo')).toHaveText('KB');
      await expect(noJs.locator('[data-profile-cover]')).toBeVisible();
      await context.close();
    },
  );

  // Partial Prerendering sends the root shell first, so both still answer 200: pin what a person
  // gets, and that search engines are told not to keep it.
  test('an unknown handle says so, with the site navigation, scripts or not', async ({
    page,
  }) => {
    const response = await page.goto(`${stack.origin}/@not_a_person`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.locator('.profile-page')).toHaveCount(0);
    await expect(
      page.getByRole('navigation', { name: 'Footer navigation' }),
    ).toBeVisible();
    await expect(page.locator('meta[name="robots"]').first()).toHaveAttribute(
      'content',
      /noindex/,
    );
    const context = await page.context().browser()!.newContext({
      javaScriptEnabled: false,
    });
    const noJs = await context.newPage();
    await noJs.goto(`${stack.origin}/@not_a_person`);
    await expect(noJs.locator('.profile-page')).toHaveCount(0);
    await expect(
      noJs.getByRole('navigation', { name: 'Footer navigation' }),
    ).toBeVisible();
    await context.close();
  });

  test('an old handle leads to the page and keeps its source', async ({
    page,
  }) => {
    // The analytics client removes the marker once counted, so check the arrival from the log.
    const seen: string[] = [];
    page.on('framenavigated', (frame) => seen.push(frame.url()));
    await page.goto(`${stack.origin}/@oldname?src=qr`);
    await expect(page).toHaveURL(/\/@kemi(\?src=qr)?$/);
    expect(seen.some((url) => url.endsWith('/@kemi?src=qr'))).toBe(true);
  });
});

test.describe('when the API fails on a page not in the cache', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);
  let stack: Stack;
  test.beforeAll(async () => {
    stack = await startStack('live');
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  for (const [state, handle] of [
    ['failing', 'longname'],
    ['hanging', 'widename'],
  ] as const)
    both(
      `${state}: a retry screen with nav and footer, scripts or not`,
      async ({ page }) => {
        stack.setApi(state);
        const started = Date.now();
        await page.goto(`${stack.origin}/@${handle}`);
        const retry = page.getByRole('link', { name: 'Try again' });
        await expect(retry).toBeVisible();
        expect(Date.now() - started).toBeLessThan(9000);
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
          'Let’s try that again',
        );
        await expect(
          page.getByRole('navigation', { name: 'Footer navigation' }),
        ).toBeVisible();
        // Not a claim that the page is gone.
        await expect(page).not.toHaveTitle(/unavailable/i);
        const context = await page.context().browser()!.newContext({
          javaScriptEnabled: false,
        });
        const noJs = await context.newPage();
        await noJs.goto(`${stack.origin}/@${handle}`);
        await expect(
          noJs.getByRole('link', { name: 'Try again' }),
        ).toBeVisible();
        await context.close();

        // Nothing about the failure is kept: the retry finds the page.
        stack.setApi('up');
        await retry.click();
        await expect(page.locator('[data-profile-card]')).toBeVisible();
      },
    );

  test('a page in the cache still shows while the API is down', async ({
    page,
  }) => {
    stack.setApi('up');
    await page.goto(`${stack.origin}/@kemi`);
    await expect(page.locator('[data-profile-card]')).toBeVisible();
    stack.setApi('failing');
    await page.reload();
    await expect(page.locator('[data-profile-card]')).toBeVisible();
    stack.setApi('up');
  });
});

test('a failed quote on a phone is announced once, from one live region outside the bar @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.route('**/v1/tip-quotes', (route) => route.abort());
  await tipButton(page).click();
  await expect(page.locator('[data-tip-panel] [aria-live]')).toHaveCount(1);
  const live = page.locator('.tip-quote-live');
  await expect(live).toHaveText(CONNECTION_COPY.tipDropped);
  expect(
    await live.evaluate((el) => el.closest('.composer-action') === null),
  ).toBe(true);
  const tree = await page.locator('[data-tip-panel]').ariaSnapshot();
  expect(tree.match(/Your tip didn’t go through/g)).toHaveLength(1);
});

for (const [name, width] of [
  ['desktop', 1800],
  ['phone', 390],
] as const) {
  test(`on a tall ${name} screen the footer sits at the bottom of the page`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 2600 });
    await page.goto('/@ada');
    const foot = (await page.locator('.profile-foot').boundingBox())!;
    const paddingBottom = await page
      .locator('.profile-page')
      .evaluate((main) => parseFloat(getComputedStyle(main).paddingBottom));
    expect(foot.y + foot.height).toBeCloseTo(2600 - paddingBottom, -1);
    expect(await fitsViewport(page)).toBe(true);
  });
}

test('on a short screen the footer keeps its gap below the content', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 500 });
  await page.goto('/@ada');
  const foot = page.locator('.profile-foot');
  const padding = await foot.evaluate((el) => {
    const style = getComputedStyle(el);
    return parseFloat(style.paddingTop) + parseFloat(style.marginTop);
  });
  expect(padding).toBeGreaterThanOrEqual(40);
});

/** Computed styles of the tip panel's parts (TipForm board materials). */
const panelLook = (page: Page) =>
  page.evaluate(() => {
    const css = (selector: string) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`missing ${selector}`);
      return getComputedStyle(element);
    };
    const probe = document.createElement('i');
    probe.style.backgroundColor = 'var(--surface-recessed)';
    document.body.append(probe);
    const recessed = getComputedStyle(probe).backgroundColor;
    probe.remove();
    const key = document.querySelector(
      '.profile-composer .tm-amount-choice input:not(:checked) + span',
    );
    const summary = document.querySelector(
      '.profile-composer .composer-extras summary',
    );
    if (!key || !summary) throw new Error('missing key or summary');
    return {
      panelImage: css('.profile-composer .appreciation-card').backgroundImage,
      panelShadow: css('.profile-composer .appreciation-card').boxShadow,
      headingFont: css('.profile-composer h2').fontFamily,
      headingWeight: css('.profile-composer h2').fontWeight,
      keyShadow: getComputedStyle(key).boxShadow,
      keyImage: getComputedStyle(key).backgroundImage,
      fieldBackground: css('.profile-composer input[inputmode="decimal"]')
        .backgroundColor,
      fieldShadow: css('.profile-composer input[inputmode="decimal"]')
        .boxShadow,
      recessed,
      submitHeight: css('.profile-composer .composer-submit').minHeight,
      submitColour: css('.profile-composer .composer-submit').backgroundColor,
      summaryBorder: getComputedStyle(summary).borderTopStyle,
      chevron: getComputedStyle(summary, '::after').transform,
    };
  });

both(
  'the tip panel is paper, the heading DM Serif, the keys raised, the fields recessed, the Tip key black',
  async ({ page }) => {
    await page.goto('/@ada');
    const panel = page.locator('.profile-composer');
    await expect(
      panel.getByRole('heading', { level: 2, name: 'Tip Ada' }),
    ).toBeVisible();
    const closed = await panelLook(page);
    expect(closed.panelImage).toContain('linear-gradient');
    expect(closed.panelShadow).not.toBe('none');
    expect(closed.headingFont).toMatch(/dmSerif|DM Serif/);
    expect(closed.headingWeight).toBe('400');
    expect(closed.keyShadow).not.toBe('none');
    expect(closed.keyImage).toContain('linear-gradient');
    expect(closed.fieldBackground).toBe(closed.recessed);
    expect(closed.fieldShadow).toContain('inset');
    expect(Number.parseFloat(closed.submitHeight)).toBeGreaterThanOrEqual(56);
    expect(closed.submitColour).toBe('rgb(0, 0, 0)');
    expect(closed.summaryBorder).toBe('solid');
    await openDetails(page);
    await expect(panel.locator('.composer-extras')).toHaveAttribute('open', '');
    const open = await panelLook(page);
    // The chevron after the words turns when the drawer opens.
    expect(open.chevron).not.toBe(closed.chevron);
  },
);

test('the red edge still wins over the well on a refused amount', async ({
  page,
}) => {
  await page.goto('/@ada');
  const field = page.locator('.profile-composer input[inputmode="decimal"]');
  const well = await field.evaluate((el) => getComputedStyle(el).borderColor);
  await field.fill('1500');
  await tipButton(page).click();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  const refused = await field.evaluate(
    (el) => getComputedStyle(el).borderColor,
  );
  expect(refused).not.toBe(well);
});

test('the checkboxes keep their keyboard behaviour and a visible focus ring', async ({
  page,
}) => {
  await page.goto('/@ada');
  await openDetails(page);
  const remember = page.getByRole('checkbox', {
    name: /Remember my tips on this phone/,
  });
  await expect(remember).not.toBeChecked();
  // Reached by keyboard: back one stop from the Tip key.
  await tipButton(page).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(remember).toBeFocused();
  await page.keyboard.press('Space');
  await expect(remember).toBeChecked();
  const ring = await remember.evaluate((el) => {
    const style = getComputedStyle(el);
    return `${style.outlineStyle} ${style.outlineWidth}`;
  });
  expect(ring).not.toMatch(/^none/);
  await page.keyboard.press('Space');
  await expect(remember).not.toBeChecked();
});

test('forced colours: the panel, keys and wells keep an edge', async ({
  page,
}) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/@ada');
  const edges = await page.evaluate(() =>
    [
      '.profile-composer .appreciation-card',
      '.profile-composer .tm-amount-choice span',
      '.profile-composer input[inputmode="decimal"]',
    ].map((selector) => {
      const style = getComputedStyle(document.querySelector(selector)!);
      return `${style.borderTopStyle} ${style.borderTopWidth}`;
    }),
  );
  for (const edge of edges) expect(edge).toMatch(/^solid [1-9]/);
  await expectAccessible(page, 'forced colours');
});
