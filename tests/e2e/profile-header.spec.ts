import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import {
  STYLE_IDS,
  startStack,
  studioFixtures,
  type Stack,
} from './profile-fixtures';

// The owner, 19 Nov 2026: on someone's tip page (/@username, every one: the standard page, Classic
// and every Studio style) the header is the TipMe logo alone, leading home, so nothing competes
// with the person's Tip button. Every other page keeps today's header.

const WIDTHS = [390, 1440] as const;
/** What the full header offers, and a tip page's header never does. */
const GONE = [
  'How it works',
  'Pro',
  'For businesses',
  'Sign in',
  'Get tipped',
  'Claim your username',
  'Go to my dashboard',
  'Business',
];

/** On the browser's own note that someone signed in here, which is all the header reads. */
const signedInHint = (page: Page) =>
  page.addInitScript(() => window.localStorage.setItem('tipme:signed-in', '1'));

async function expectLogoOnly(page: Page, label: string) {
  const header = page.locator('header.site-header');
  await expect(header, label).toHaveCount(1);
  await expect(header, label).toBeVisible();
  // What anyone can see, tab to or hear: one link in the whole header, no button, no navigation.
  await expect(header.getByRole('link'), label).toHaveCount(1);
  await expect(header.getByRole('button'), label).toHaveCount(0);
  await expect(header.getByRole('navigation'), label).toHaveCount(0);
  await expect(header.locator('.site-nav'), label).toBeHidden();
  await expect(header.locator('.menu-toggle').first(), label).toBeHidden();
  const logo = header.getByRole('link', { name: 'TipMe home' });
  await expect(logo, label).toBeVisible();
  await expect(logo, label).toHaveAttribute('href', '/');
  for (const name of GONE)
    await expect(
      header.getByRole('link', { name, exact: true }),
      `${label}: ${name}`,
    ).toHaveCount(0);
  await expect(page.getByRole('button', { name: /menu/i }), label).toHaveCount(
    0,
  );
}

/** The first two stops: the skip link, then the logo. */
async function expectFocusOrder(page: Page, label: string) {
  await page.locator('body').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus'), label).toHaveText('Skip to content');
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus'), label).toHaveAccessibleName(
    'TipMe home',
  );
}

const fits = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

test.describe('the standard tip page', () => {
  test('signed out, the header is the logo alone at 390 and 1440', async ({
    page,
  }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/@ada');
      await expect(page.getByRole('main')).toBeVisible();
      await expectLogoOnly(page, `/@ada at ${width}`);
    }
    await expectFocusOrder(page, '/@ada');
    await expectAccessible(page);
    await page.setViewportSize({ width: 320, height: 800 });
    expect(await fits(page), '/@ada at 320').toBe(true);
  });

  test('signed in, the header is still the logo alone', async ({
    page,
  }, testInfo) => {
    await signUpRecipient(page, testInfo, { live: false });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/@ada');
      await expect(page.getByRole('main')).toBeVisible();
      await expectLogoOnly(page, `/@ada signed in at ${width}`);
    }
    // The header itself still knows them elsewhere.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/for-creators');
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'Go to my dashboard' }),
    ).toBeVisible();
  });
});

test.describe('the full header stays everywhere else', () => {
  for (const path of ['/', '/pro'])
    test(`${path} keeps today's header at 390 and 1440`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(path);
      const nav = page.getByRole('navigation', { name: 'Main navigation' });
      for (const name of ['How it works', 'Pro', 'Sign in'])
        await expect(
          nav.getByRole('link', { name, exact: true }),
          `${path}: ${name}`,
        ).toBeVisible();
      await expect(
        nav.getByRole('button', { name: "Who it's for" }),
      ).toBeVisible();
      // On Home "Get tipped" steps aside while the hero's claim form is on screen (header.spec.ts).
      await expect(
        nav.getByRole('link', { name: /Get tipped/, includeHidden: true }),
      ).toHaveCount(1);
      await page.setViewportSize({ width: 390, height: 900 });
      await page.getByRole('button', { name: 'Open menu' }).click();
      for (const name of ['How it works', 'Sign in', 'Get tipped'])
        await expect(
          nav.getByRole('link', { name, exact: true }),
          `${path} at 390: ${name}`,
        ).toBeVisible();
    });

  test('going from a tip page to Home brings the full header back', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/@ada');
    await expectLogoOnly(page, '/@ada');
    await page
      .locator('header.site-header')
      .getByRole('link', { name: 'TipMe home' })
      .click();
    await page.waitForURL((url) => url.pathname === '/');
    await expect(
      page
        .getByRole('navigation', { name: 'Main navigation' })
        .getByRole('link', { name: 'How it works' }),
    ).toBeVisible();
  });
});

test.describe('a Studio-styled tip page', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);
  let stack: Stack;
  test.beforeAll(async () => {
    await studioFixtures();
    stack = await startStack('test');
  });
  test.afterAll(async () => {
    await stack.stop();
  });

  test('every style shows the logo alone, signed out and signed in', async ({
    browser,
  }) => {
    for (const signedIn of [false, true]) {
      const context = await browser.newContext();
      const page = await context.newPage();
      if (signedIn) await signedInHint(page);
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 900 });
        for (const style of STYLE_IDS) {
          const label = `/@style${style} at ${width}${signedIn ? ', signed in' : ''}`;
          await page.goto(`${stack.origin}/@style${style}`);
          await page.locator(`[data-style="${style}"]`).first().waitFor();
          await expectLogoOnly(page, label);
        }
      }
      await context.close();
    }
  });

  test('over the cover the logo alone is accessible, reachable and fits 320', async ({
    page,
  }) => {
    for (const style of ['stage', 'clear', 'signboard'] as const) {
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(`${stack.origin}/@style${style}`);
      await page.locator('.studio[data-style]').waitFor();
      await expectFocusOrder(page, style);
      await expectAccessible(page);
      await page.setViewportSize({ width: 320, height: 800 });
      expect(await fits(page), `${style} at 320`).toBe(true);
    }
  });
});
