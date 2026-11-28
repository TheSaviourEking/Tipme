import { expect, test, type Page } from '@playwright/test';
import { signUpRecipient } from './helpers';

// An open page tells its visitor when TipMe has been updated, and reloads only when asked
// (owner's request, 3 Nov 2026). The production build is what these tests run against.

const NOTICE = 'TipMe has been updated.';

const serverUpdated = (page: Page) =>
  page.route('**/api/version', (route) =>
    route.fulfill({
      json: { version: 'a-newer-build' },
      headers: { 'cache-control': 'no-store' },
    }),
  );

/** Bring the tab back: the page checks when it becomes visible again. */
const comeBack = (page: Page) =>
  page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/** The listener attaches after hydration, so keep returning until the check has run. */
const comeBackUntil = async (page: Page, done: () => Promise<boolean>) => {
  await expect
    .poll(async () => {
      await comeBack(page);
      return done();
    })
    .toBe(true);
};

const notice = (page: Page) =>
  page.getByRole('status').filter({ hasText: NOTICE });

test('an open page offers a refresh when TipMe has been updated', async ({
  page,
}) => {
  await page.goto('/');
  await serverUpdated(page);
  await comeBackUntil(page, () => notice(page).isVisible());
  await expect(
    notice(page).getByRole('button', { name: 'Refresh' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
  // Nothing reloaded by itself.
  const marker = await page.evaluate(() => {
    (window as unknown as { __open: boolean }).__open = true;
    return true;
  });
  expect(marker).toBe(true);
  await comeBack(page);
  expect(
    await page.evaluate(
      () => (window as unknown as { __open?: boolean }).__open,
    ),
  ).toBe(true);
  const reloaded = page.waitForEvent('load');
  await notice(page).getByRole('button', { name: 'Refresh' }).click();
  await reloaded;
  expect(
    await page.evaluate(
      () => (window as unknown as { __open?: boolean }).__open,
    ),
  ).toBeUndefined();
});

test('the same version shows nothing', async ({ page }) => {
  await page.goto('/');
  let checks = 0;
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/api/version') checks += 1;
  });
  await comeBackUntil(page, async () => checks > 0);
  await page.waitForTimeout(300);
  await expect(notice(page)).toHaveCount(0);
});

test('Later hides it', async ({ page }) => {
  await page.goto('/');
  await serverUpdated(page);
  await comeBackUntil(page, () => notice(page).isVisible());
  await notice(page).getByRole('button', { name: 'Later' }).click();
  await expect(notice(page)).toHaveCount(0);
  await comeBack(page);
  await page.waitForTimeout(300);
  await expect(notice(page)).toHaveCount(0);
});

test('a failing version check shows nothing', async ({ page }) => {
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(error.message));
  await page.goto('/');
  let checks = 0;
  await page.route('**/api/version', (route) => {
    checks += 1;
    return route.fulfill({ status: 500, body: 'nope' });
  });
  await comeBackUntil(page, async () => checks > 0);
  await page.waitForTimeout(300);
  await expect(notice(page)).toHaveCount(0);
  expect(problems).toEqual([]);
});

test('the version endpoint says the build and is never cached', async ({
  request,
}) => {
  const response = await request.get('/api/version');
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toContain('no-store');
  const body = (await response.json()) as { version: string };
  expect(Object.keys(body)).toEqual(['version']);
  expect(body.version).toMatch(/\S+/);
});

test('on a phone the notice leaves the Tip bar and its button free @mobile', async ({
  page,
}) => {
  await page.goto('/@ada');
  await serverUpdated(page);
  await comeBackUntil(page, () => notice(page).isVisible());
  const bar = await page.locator('.composer-action').boundingBox();
  const card = await notice(page).boundingBox();
  expect(bar).not.toBeNull();
  expect(card).not.toBeNull();
  expect(card!.y + card!.height).toBeLessThanOrEqual(bar!.y);
  const viewport = page.viewportSize()!;
  expect(card!.x).toBeGreaterThanOrEqual(0);
  expect(card!.x + card!.width).toBeLessThanOrEqual(viewport.width);
  for (const name of ['Refresh', 'Later']) {
    const box = await notice(page).getByRole('button', { name }).boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.width).toBeGreaterThanOrEqual(44);
  }
});

test('on the dashboard the notice and the tab bar never overlap @mobile', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard');
  await serverUpdated(page);
  await comeBackUntil(page, () => notice(page).isVisible());
  const bar = await page
    .getByRole('navigation', { name: 'Dashboard' })
    .boundingBox();
  const card = await notice(page).boundingBox();
  expect(bar).not.toBeNull();
  expect(card).not.toBeNull();
  expect(card!.y + card!.height).toBeLessThanOrEqual(bar!.y);
});

// How often the notice checks follows the page's live streams (addendum §3.5). These tests fake
// the page's clock; every entry below is timed on that clock (performance.now), so a check and
// the stream ready that caused it can be told apart.

interface Seen {
  kind: 'connect' | 'ready' | 'check';
  at: number;
}

/** Records each stream connect, each stream ready and each version check, in order. */
async function recordChecks(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __seen: Seen[] };
    w.__seen = [];
    const seen = (kind: Seen['kind']) =>
      w.__seen.push({ kind, at: performance.now() });
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (new URL(url, location.href).pathname === '/api/version')
        seen('check');
      return nativeFetch(input, init);
    };
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        seen('connect');
        this.addEventListener('message', (event) => {
          try {
            const { type } = JSON.parse(String(event.data)) as {
              type?: unknown;
            };
            if (type === 'ready') seen('ready');
          } catch {
            // Not ours to judge: the client ignores it too.
          }
        });
      }
    };
  });
}

const seenSoFar = (page: Page) =>
  page.evaluate(() => (window as unknown as { __seen: Seen[] }).__seen);

const count = async (page: Page, kind: Seen['kind']) =>
  (await seenSoFar(page)).filter((entry) => entry.kind === kind).length;

test('a connected dashboard checks the version on each stream ready, not on a timer', async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await recordChecks(page);
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard');
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  // The stream's first ready checks once.
  await expect.poll(() => count(page, 'check')).toBe(1);
  await page.waitForTimeout(2_000);
  expect(await count(page, 'check')).toBe(1);

  // Six minutes pass with no heartbeat: a 5-minute timer would check, and the client's watchdog
  // starts the stream again (L-R12). Only the reconnect's ready may check.
  await page.clock.fastForward('06:00');
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 20_000,
  });
  await expect.poll(() => count(page, 'ready'), { timeout: 20_000 }).toBe(2);
  await expect.poll(() => count(page, 'check')).toBe(2);
  await page.waitForTimeout(2_000);

  const seen = await seenSoFar(page);
  expect(seen.filter((entry) => entry.kind === 'connect').length).toBe(2);
  // Every check follows its own ready: no check without a ready since the one before.
  let readySinceCheck = false;
  for (const entry of seen) {
    if (entry.kind === 'ready') readySinceCheck = true;
    if (entry.kind !== 'check') continue;
    expect(readySinceCheck, JSON.stringify(seen)).toBe(true);
    readySinceCheck = false;
  }
  // At most once a minute.
  const checks = seen.filter((entry) => entry.kind === 'check');
  for (let i = 1; i < checks.length; i += 1)
    expect(checks[i]!.at - checks[i - 1]!.at).toBeGreaterThanOrEqual(60_000);
});

test('a dashboard with live updates off checks every 5 minutes', async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await recordChecks(page);
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204 }),
  );
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard');
  await expect(page.locator('[data-live="disabled"]')).toBeAttached({
    timeout: 15_000,
  });
  expect(await count(page, 'check')).toBe(0);
  // The provider joined before the stream said it was off; the interval started then.
  await page.clock.fastForward('04:30');
  await page.waitForTimeout(500);
  expect(await count(page, 'check')).toBe(0);
  await page.clock.fastForward('01:00');
  await expect.poll(() => count(page, 'check')).toBe(1);
  await page.clock.fastForward('05:00');
  await expect.poll(() => count(page, 'check')).toBe(2);
});

test('a public page checks every 30 minutes', async ({ page }) => {
  await page.clock.install();
  await recordChecks(page);
  await page.goto('/');
  // The notice is listening (so its interval is armed) once coming back checks.
  await comeBackUntil(page, async () => (await count(page, 'check')) > 0);
  await page.waitForTimeout(500);
  const base = await count(page, 'check');

  await page.clock.fastForward('05:00');
  await page.waitForTimeout(500);
  expect(await count(page, 'check')).toBe(base);
  await page.clock.fastForward('24:00');
  await page.waitForTimeout(500);
  expect(await count(page, 'check')).toBe(base);
  await page.clock.fastForward('01:30');
  await expect.poll(() => count(page, 'check')).toBe(base + 1);
});
