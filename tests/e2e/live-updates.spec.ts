import { expect, test, type Browser, type Page } from '@playwright/test';
import { signInWithEmail, signUpRecipient, tipAsVisitor } from './helpers';

// Live updates (docs/superpowers/specs/2026-11-03-live-updates-design.md §11.3): a tip lands and
// the open dashboard shows it with no reload. 5 s is well under the 20 s fallback poll, so passing
// within it means the stream did it.
const LIVE_BOUND_MS = 5000;

/**
 * The first tip leaves the first-day screen, so the balance card and the list are showing. Its
 * notifications (the tip and the first-tip moment) must exist before the page the test watches
 * loads: otherwise the bell announces them, and the once-a-minute rule holds the next tip back.
 */
async function dashboardAfterFirstTip(
  page: Page,
  handle: string,
  browser: Browser,
) {
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await page.goto('/dashboard');
  await expect(page.getByTestId('balance')).toHaveText('NGN 1,800.00', {
    timeout: 15_000,
  });
  await expect(
    page.getByRole('button', { name: 'Notifications, 2 unread' }),
  ).toBeVisible({ timeout: 25_000 });
  await page.reload();
  await expect(page.getByTestId('balance')).toHaveText('NGN 1,800.00');
}

/** Marks the page (a reload would clear it) and records every text the balance shows. */
async function watchBalance(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __noReload: number;
      __balances: string[];
    };
    w.__noReload = 1;
    const balance = document.querySelector('[data-testid="balance"]')!;
    w.__balances = [balance.textContent ?? ''];
    new MutationObserver(() => {
      const text = balance.textContent ?? '';
      if (w.__balances.at(-1) !== text) w.__balances.push(text);
    }).observe(balance, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });
}

const noReload = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __noReload?: number }).__noReload,
  );
const balances = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __balances: string[] }).__balances,
  );

test('a visitor tips and the signed-in dashboard’s balance and tip list update with no reload', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const { handle } = await signUpRecipient(page, testInfo);
  await dashboardAfterFirstTip(page, handle, browser);
  await watchBalance(page);
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });

  await tipAsVisitor(browser, handle, { amount: '2,000 NGN', name: 'Chidi' });

  await expect(page.getByTestId('balance')).toHaveText('NGN 3,600.00', {
    timeout: LIVE_BOUND_MS,
  });
  const first = page.locator('.dashboard-recent .activity-list a').first();
  await expect(first).toHaveText(/Tip from Chidi/, { timeout: LIVE_BOUND_MS });
  await expect(first).toContainText('Paid');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'You got a tip · NGN 1,800.00 from Chidi' }),
  ).toBeVisible({ timeout: LIVE_BOUND_MS });
  expect(await noReload(page)).toBe(1);
  // The money never performs: only the old figure and the new one, nothing in between.
  expect(await balances(page)).toEqual(['NGN 1,800.00', 'NGN 3,600.00']);
});

test('with reduced motion the new row appears with no running animations', async ({
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  try {
    const { handle } = await signUpRecipient(page, testInfo);
    await dashboardAfterFirstTip(page, handle, browser);
    await expect(page.locator('[data-live="connected"]')).toBeAttached({
      timeout: 15_000,
    });
    await tipAsVisitor(browser, handle, { name: 'Chidi' });
    const row = page
      .locator('.dashboard-recent .activity-list a')
      .filter({ hasText: 'Tip from Chidi' });
    await expect(row).toBeVisible({ timeout: LIVE_BOUND_MS });
    // Still marked as arriving (the class lasts 1 s), and nothing moves.
    expect(await row.evaluate((el) => el.getAnimations().length)).toBe(0);
  } finally {
    await context.close();
  }
});

test('with the stream blocked the balance still updates within 25 s', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const { handle } = await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/events', (route) => route.abort());
  await dashboardAfterFirstTip(page, handle, browser);
  await watchBalance(page);
  await tipAsVisitor(browser, handle, { name: 'Chidi' });
  await expect(page.getByTestId('balance')).toHaveText('NGN 3,600.00', {
    timeout: 25_000,
  });
  expect(await noReload(page)).toBe(1);
  await expect(page.locator('[data-live="polling"]')).toBeAttached();
});

test('a signed-in user signed out elsewhere goes to sign-in without a reload', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const who = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard');
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  await page.evaluate(() => {
    (window as unknown as { __noReload: number }).__noReload = 1;
  });
  const other = await browser.newContext();
  try {
    const second = await other.newPage();
    await signInWithEmail(second, who.email);
    await second.waitForURL(/\/dashboard/);
    await second.goto('/dashboard/settings');
    await second
      .getByRole('button', { name: 'Sign out of all other devices' })
      .click();
    await expect(page).toHaveURL(/\/sign-in/, { timeout: LIVE_BOUND_MS });
    // A client-side redirect, not a reload.
    expect(await noReload(page)).toBe(1);
  } finally {
    await other.close();
  }
});
