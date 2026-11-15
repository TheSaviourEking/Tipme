import { expect, test, type Page, type Route } from '@playwright/test';
import { signUpRecipient } from './helpers';
import { sql } from './ops-helpers';

/*
 * UI audit (15 Nov 2026), items 3 and 4: a read that fails on TipMe's side is not "signed out",
 * and a panel whose first read fails ends in an error with Try again, never an endless skeleton.
 * The failures are route stubs; the account itself is real.
 */

// Each test signs up a real account first, then visits two or three dashboard pages.
test.describe.configure({ timeout: 60_000 });

const fail = (route: Route, status = 500) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify({
      error: { code: status === 401 ? 'UNAUTHENTICATED' : 'INTERNAL_ERROR' },
    }),
  });

/**
 * Answers the person's own reads with a failure, except the ones `keep` lets through. The live
 * stream answers 204 (tests/e2e/AGENTS.md) unless `events` says otherwise.
 */
async function failReads(
  page: Page,
  {
    keep = [],
    events = 204,
    status = 500,
  }: { keep?: string[]; events?: number; status?: number } = {},
) {
  await page.route('**/v1/me/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me/events')
      return events === 204
        ? route.fulfill({ status: 204 })
        : fail(route, events);
    if (route.request().method() !== 'GET' || keep.includes(path))
      return route.fallback();
    return fail(route, status);
  });
}

test('a server error reading the profile shows an error with Try again, not Sign in', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await failReads(page);
  await page.goto('/dashboard/tips');
  const slip = page.getByRole('alert').filter({
    hasText: 'We couldn’t load your dashboard',
  });
  await expect(slip).toBeVisible();
  await expect(slip).toContainText('This is usually brief. Please try again.');
  await expect(page).toHaveURL(/\/dashboard\/tips$/);
  await expect(page.getByText('Welcome back.')).toHaveCount(0);

  // Still failing: it says so, and stays.
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(slip).toContainText('Still not loading.');
  await expect(page).toHaveURL(/\/dashboard\/tips$/);

  // Back: Try again loads the page in place.
  await page.unroute('**/v1/me/**');
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your tips' }),
  ).toBeVisible();
  await expect(slip).toHaveCount(0);
});

test('a network failure reading the profile is not Sign in either', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.route('**/v1/me/**', (route) =>
    new URL(route.request().url()).pathname === '/v1/me/events'
      ? route.fulfill({ status: 204 })
      : route.abort('failed'),
  );
  await page.goto('/dashboard');
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'We couldn’t load your dashboard' }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/dashboard$/);
});

test('a signed-out answer still goes to Sign in and comes back', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await failReads(page, { status: 401 });
  await page.goto('/dashboard/tips');
  await page.waitForURL(/\/sign-in\?next=%2Fdashboard%2Ftips$/);
});

for (const events of [204, 500]) {
  test(`Tips and Earnings end in an error with Try again when their reads fail (stream ${events})`, async ({
    page,
  }, testInfo) => {
    await signUpRecipient(page, testInfo, { live: false });
    await failReads(page, { keep: ['/v1/me/profile'], events });

    await page.goto('/dashboard/tips');
    const tips = page
      .getByRole('alert')
      .filter({ hasText: 'We couldn’t load your tips' });
    await expect(tips).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole('status').filter({ hasText: 'Loading your tips' }),
    ).toHaveCount(0);

    await page.goto('/dashboard/earnings');
    const earnings = page
      .getByRole('alert')
      .filter({ hasText: 'We couldn’t load your earnings' });
    await expect(earnings).toBeVisible({ timeout: 10_000 });

    // Try again reads again, and the page appears once the API answers.
    await page.unroute('**/v1/me/**');
    await page.route('**/v1/me/events', (route) =>
      route.fulfill({ status: 204 }),
    );
    await earnings.getByRole('button', { name: 'Try again' }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: 'Earnings' }),
    ).toBeVisible();
  });
}

test('Tips keeps its skeleton only while the read is open, then shows the error', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/v1/me/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me/events') return route.fulfill({ status: 204 });
    if (path !== '/v1/me/tips') return route.fallback();
    await held;
    return fail(route);
  });
  await page.goto('/dashboard/tips');
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading your tips' }),
  ).toBeVisible();
  release();
  await expect(
    page.getByRole('alert').filter({ hasText: 'We couldn’t load your tips' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
});

test('a Tips read that never answers ends in the error, not an endless skeleton', async ({
  page,
}, testInfo) => {
  // The panel's read gives up after 15 s (apps/web/src/lib/panel-read.ts).
  test.setTimeout(90_000);
  await signUpRecipient(page, testInfo, { live: false });
  await page.route('**/v1/me/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/v1/me/events') return route.fulfill({ status: 204 });
    if (path !== '/v1/me/tips') return route.fallback();
    // Never answered: the page has to give up on it by itself.
    return new Promise<void>(() => undefined);
  });
  await page.goto('/dashboard/tips');
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading your tips' }),
  ).toBeVisible();
  await expect(
    page.getByRole('alert').filter({ hasText: 'We couldn’t load your tips' }),
  ).toBeVisible({ timeout: 25_000 });
  await page.unroute('**/v1/me/**');
  await page.route('**/v1/me/events', (route) =>
    route.fulfill({ status: 204 }),
  );
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByText('No tips here yet.')).toBeVisible();
});

test('a monthly recap that isn’t made yet is a neutral note, not an error', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo, { live: false });
  await sql(`UPDATE profiles SET plan = 'pro' WHERE handle_lower = $1`, [
    handle,
  ]);
  const month = new Date().toISOString().slice(0, 7);
  await page.goto(`/dashboard/reports/month/${month}`);
  const main = page.getByRole('main');
  await expect(
    main
      .getByRole('status')
      .filter({ hasText: 'This month’s recap isn’t ready yet' }),
  ).toBeVisible();
  await expect(main.getByRole('alert')).toHaveCount(0);
});
