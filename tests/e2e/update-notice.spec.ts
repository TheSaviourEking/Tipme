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
