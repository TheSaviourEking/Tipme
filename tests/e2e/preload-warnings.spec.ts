import { expect, test, type Page } from '@playwright/test';
import { signUpRecipient } from './helpers';
import { enrolOwner } from './ops-helpers';
import { STYLE_IDS, startStack } from './profile-fixtures';

// Chrome warned "The resource … was preloaded using link preload but not used within a few seconds
// from the window's load event" (owner, 17 Nov 2026). The resource was studio.css: Next.js
// prefetches a visible link to /@username, and the prefetch preloaded that route's stylesheet on
// the dashboard, /ops and /sign-in, where nothing used it. Every main route must load only what it
// uses. Chrome checks once, 3 s after load; the wait gives it 4. Its warning depends on when the
// prefetch lands, so each route is also checked directly: every preloaded stylesheet is applied.

const PRELOAD_WARNING = /preloaded using link preload but not used/;

async function expectNoUnusedPreloads(page: Page, url: string) {
  const warnings: string[] = [];
  const listen = (message: { text: () => string }) => {
    if (PRELOAD_WARNING.test(message.text())) warnings.push(message.text());
  };
  page.on('console', listen);
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(4000);
    const { fonts, unusedStyles } = await page.evaluate(() => {
      const path = (href: string) => new URL(href, location.href).pathname;
      const hrefs = (selector: string) =>
        [...document.querySelectorAll<HTMLLinkElement>(selector)].map((l) =>
          path(l.href),
        );
      const applied = new Set(hrefs('link[rel="stylesheet"]'));
      return {
        fonts: hrefs('link[rel="preload"][as="font"]'),
        unusedStyles: hrefs('link[rel="preload"][as="style"]').filter(
          (href) => !applied.has(href),
        ),
      };
    });
    test.info().annotations.push({
      type: 'preloads',
      description: `${url}: fonts ${JSON.stringify(fonts)}`,
    });
    expect
      .soft(warnings, `${url}: Chrome's unused-preload warnings`)
      .toEqual([]);
    expect
      .soft(unusedStyles, `${url}: stylesheets preloaded but not applied`)
      .toEqual([]);
    return fonts;
  } finally {
    page.off('console', listen);
  }
}

test.describe('no unused preloads', () => {
  test.setTimeout(120_000);

  test('public pages', async ({ page }) => {
    for (const url of ['/', '/sign-in', '/@tobi'])
      await expectNoUnusedPreloads(page, url);
  });

  test('dashboard, and public pages while signed in', async ({
    page,
  }, testInfo) => {
    // Not made live: the dashboard links to the page either way, which is what prefetched it.
    await signUpRecipient(page, testInfo, { live: false });
    for (const url of ['/dashboard', '/dashboard/settings', '/', '/@tobi'])
      await expectNoUnusedPreloads(page, url);
  });

  test('admin pages', async ({ page }, testInfo) => {
    await enrolOwner(page, testInfo);
    for (const url of ['/ops', '/ops/users'])
      await expectNoUnusedPreloads(page, url);
  });

  test('Studio pages preload only their own heading font', async ({ page }) => {
    const stack = await startStack('test');
    try {
      // Classic keeps today's fonts and preloads; every other style preloads its name face.
      for (const style of STYLE_IDS.filter((id) => id !== 'classic')) {
        const url = `${stack.origin}/@style${style}`;
        const fonts = await expectNoUnusedPreloads(page, url);
        expect(
          fonts.filter((f) => f.startsWith('/fonts/studio/')),
          style,
        ).toEqual([expect.stringMatching(/^\/fonts\/studio\/[\w-]+\.woff2$/)]);
        // The design still gets its stylesheet (frame.css paints the page in its own colours).
        const painted = await page.evaluate(() => {
          const probe = document.createElement('i');
          probe.style.color = getComputedStyle(
            document.querySelector('.studio')!,
          ).getPropertyValue('--studio-bg');
          document.body.append(probe);
          const bg = getComputedStyle(probe).color;
          probe.remove();
          return (
            bg === getComputedStyle(document.documentElement).backgroundColor
          );
        });
        expect(painted, style).toBe(true);
      }
    } finally {
      await stack.stop();
    }
  });
});
