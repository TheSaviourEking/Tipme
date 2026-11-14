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
  // Reloads until both exist, so the setup never depends on the stream it is about to test.
  await expect(async () => {
    await page.goto('/dashboard');
    await expect(page.getByTestId('balance')).toHaveText('₦1,860', {
      timeout: 2000,
    });
    await expect(
      page.getByRole('button', { name: 'Notifications, 2 unread' }),
    ).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  // A fresh page that saw both on its first read: nothing announced, no minute window started.
  await page.reload();
  await expect(page.getByTestId('balance')).toHaveText('₦1,860');
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

  await expect(page.getByTestId('balance')).toHaveText('₦3,720', {
    timeout: LIVE_BOUND_MS,
  });
  const first = page.locator('.dashboard-recent .activity-list a').first();
  await expect(first).toHaveText(/Tip from Chidi/, { timeout: LIVE_BOUND_MS });
  await expect(first).toContainText('Paid');
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'You got a tip · NGN 1,860.00 from Chidi' }),
  ).toBeVisible({ timeout: LIVE_BOUND_MS });
  expect(await noReload(page)).toBe(1);
  // The money never performs: only the old figure and the new one, nothing in between.
  expect(await balances(page)).toEqual(['₦1,860', '₦3,720']);
});

/**
 * The new row as the page first rendered it, recorded the moment it appears (a MutationObserver
 * set up before the tip), so the 240 ms animation can't have ended before the test looks.
 */
async function arrivalOf(page: Page, browser: Browser, handle: string) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __arrival?: { marked: boolean; animationName: string; text: string };
    };
    const list = document.querySelector('.dashboard-recent')!;
    new MutationObserver(() => {
      if (w.__arrival) return;
      const row = list.querySelector<HTMLElement>(
        '.activity-list__row--arriving',
      );
      if (!row) return;
      w.__arrival = {
        marked: row.classList.contains('activity-list__row--arriving'),
        animationName: getComputedStyle(row).animationName,
        text: row.textContent ?? '',
      };
    }).observe(list, { subtree: true, childList: true, attributes: true });
  });
  await tipAsVisitor(browser, handle, { name: 'Chidi' });
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as unknown as { __arrival?: unknown }).__arrival ?? null,
        ),
      { timeout: LIVE_BOUND_MS },
    )
    .not.toBeNull();
  return page.evaluate(
    () =>
      (
        window as unknown as {
          __arrival: { marked: boolean; animationName: string; text: string };
        }
      ).__arrival,
  );
}

for (const reducedMotion of ['reduce', 'no-preference'] as const) {
  test(`the new row is marked arriving; ${reducedMotion === 'reduce' ? 'with reduced motion it does not move' : 'without reduced motion it slides in (the control)'}`, async ({
    browser,
  }, testInfo) => {
    test.setTimeout(90_000);
    const context = await browser.newContext({ reducedMotion });
    const page = await context.newPage();
    try {
      const { handle } = await signUpRecipient(page, testInfo);
      await dashboardAfterFirstTip(page, handle, browser);
      await expect(page.locator('[data-live="connected"]')).toBeAttached({
        timeout: 15_000,
      });
      const arrival = await arrivalOf(page, browser, handle);
      expect(arrival.text).toContain('Tip from Chidi');
      expect(arrival.marked).toBe(true);
      // The computed style doesn't depend on timing: the rule either applies or it doesn't.
      expect(arrival.animationName).toBe(
        reducedMotion === 'reduce' ? 'none' : 'activity-arrive',
      );
    } finally {
      await context.close();
    }
  });
}

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
  await expect(page.getByTestId('balance')).toHaveText('₦3,720', {
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

/** Counts the page's GETs to the API, by path (`?unreadOnly=1` kept apart). */
function countReads(page: Page) {
  const counts: Record<string, number> = {};
  page.on('request', (request) => {
    if (request.method() !== 'GET') return;
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/v1/me/')) return;
    const key =
      url.pathname + (url.searchParams.has('unreadOnly') ? '?unreadOnly' : '');
    counts[key] = (counts[key] ?? 0) + 1;
  });
  return counts;
}

test('a load reads each panel once while the stream connects (no double read)', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await signUpRecipient(page, testInfo);
  const counts = countReads(page);
  await page.goto('/dashboard');
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  await expect(page.getByTestId('balance')).toBeVisible();
  // Past the 1.5 s cap and any debounce: every read the load will make has been made.
  await page.waitForTimeout(2500);
  for (const path of [
    '/v1/me/dashboard',
    '/v1/me/activity',
    '/v1/me/reports',
    '/v1/me/moments',
    '/v1/me/notifications?unreadOnly',
  ])
    expect(counts[path], `${path}: ${JSON.stringify(counts)}`).toBe(1);
});

test('a tip paid while the stream is still connecting still shows, with no reload', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const { handle } = await signUpRecipient(page, testInfo);
  await dashboardAfterFirstTip(page, handle, browser);
  // Hold the stream's request: the panels read after 1.5 s without it, then a tip is paid before
  // the stream has registered.
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/v1/me/events', async (route) => {
    await gate;
    await route.continue();
  });
  await page.reload();
  await expect(page.getByTestId('balance')).toHaveText('₦1,860', {
    timeout: 10_000,
  });
  await watchBalance(page);
  await tipAsVisitor(browser, handle, { name: 'Chidi' });
  await page.waitForTimeout(1000);
  await expect(page.getByTestId('balance')).toHaveText('₦1,860');
  // The stream registers now; its ready resync reads after the tip.
  release();
  await expect(page.getByTestId('balance')).toHaveText('₦3,720', {
    timeout: LIVE_BOUND_MS + 2000,
  });
  expect(await noReload(page)).toBe(1);
  expect(await balances(page)).toEqual(['₦1,860', '₦3,720']);
});

test('the Withdraw page asks for its quote once per visit, through focus and reconnects', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await signUpRecipient(page, testInfo);
  const counts = countReads(page);
  await page.goto('/dashboard/withdraw');
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  // A tab coming back into view, and the network coming back (which reconnects the stream).
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('online'));
  });
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  // The reconnect's re-read comes within 0–5 s: wait past it.
  await page.waitForTimeout(6000);
  expect(counts['/v1/me/withdrawal-quote'], JSON.stringify(counts)).toBe(1);
  expect(counts['/v1/me/dashboard'], JSON.stringify(counts)).toBe(1);
});
