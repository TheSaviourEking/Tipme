import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInWithEmail, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';

// Changelog plan (5 Nov 2026), Tasks 6.3 and 6.4: What's new in the dashboard. The ingest and admin
// PRs are built beside this one, so entries are seeded with SQL.
//
// Entries are global, so this file runs in order and removes its own entries after each test.
// They go live on fixed days in January 2026 and only this file's person is dated before them:
// everyone else signed up in this run joined later, so they never get a dot or a slip from these.
test.describe.configure({ mode: 'serial' });

const JOINED = '2025-12-01T00:00:00Z';
const base = 700_000 + Math.floor(Math.random() * 90_000) * 10;
let seeded: number[] = [];

async function seed(
  offset: number,
  values: {
    text: string;
    liveAt: string;
    audience?: 'everyone' | 'pro' | 'early_access';
  },
) {
  const number = base + offset;
  const audience = values.audience ?? 'everyone';
  await sql(
    `INSERT INTO changelog_entries (pr_number, merge_sha, merged_at, pr_title, staff_text, user_text,
       audience, published_text, published_audience, published_revision, approved_at, live_at,
       live_version)
     VALUES ($1, $2, '2025-12-20T10:00:00Z', $3, $4, $5, $6, $5, $6, 1, '2025-12-21T10:00:00Z', $7,
       'abcdef012345')`,
    [
      number,
      String(number).padStart(40, 'c'),
      `feat: staff title ${number}`,
      `Staff text ${number}`,
      values.text,
      audience,
      values.liveAt,
    ],
  );
  seeded.push(number);
  return number;
}

/** Dates this person before the seeded updates, so they are new to them. */
const joinedBefore = (handle: string) =>
  sql('UPDATE profiles SET created_at = $1 WHERE handle_lower = $2', [
    JOINED,
    handle.toLowerCase(),
  ]);

/** Two updates: an everyday one, then a newer Pro one. */
async function twoUpdates() {
  await seed(1, {
    text: 'You can pin a supporter note to your page.',
    liveAt: '2026-01-03T10:00:00Z',
  });
  await seed(2, {
    text: 'You can pick a starting amount.',
    audience: 'pro',
    liveAt: '2026-01-05T10:00:00Z',
  });
}

const menuItem = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Dashboard' })
    .getByRole('link', { name: /^What’s new/ });
const slip = (page: Page) =>
  page.locator('.whats-new-slip').filter({ hasText: 'New in TipMe' });

test.afterEach(async () => {
  if (seeded.length > 0)
    await sql('DELETE FROM changelog_entries WHERE pr_number = ANY($1)', [
      seeded,
    ]);
  seeded = [];
});

test('after an update goes live, the menu shows a dot and Home shows one slip with the newest line', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await joinedBefore(handle);
  await twoUpdates();
  await page.goto('/dashboard');
  await expect(menuItem(page)).toHaveAccessibleName('What’s new (new updates)');
  await expect(slip(page)).toHaveCount(1);
  await expect(slip(page)).toContainText(
    'On Pro, you can pick a starting amount.',
  );
  await expect(slip(page)).toContainText('(and 1 more)');
  await expect(slip(page)).not.toContainText('supporter note');
  await expect(
    slip(page).getByRole('link', { name: 'See what’s new' }),
  ).toHaveAttribute('href', '/dashboard/whats-new');
  await expectAccessible(page);
});

test('closing the slip clears it and the dot, and a second browser context for the same person sees neither', async ({
  page,
  browser,
}, testInfo) => {
  const { handle, email } = await signUpRecipient(page, testInfo);
  await joinedBefore(handle);
  await twoUpdates();
  await page.goto('/dashboard');
  await expect(slip(page)).toBeVisible();
  await slip(page).getByRole('button', { name: 'Close' }).click();
  await expect(slip(page)).toHaveCount(0);
  await expect(menuItem(page)).toHaveAccessibleName('What’s new');
  // Focus lands on the page's first heading, not lost at the top of the document.
  await expect(page.locator('.dashboard-home__main h1').first()).toBeFocused();
  await expectAccessible(page);

  // Another device: the marker is on the server.
  const other = await (await browser.newContext()).newPage();
  try {
    await signInWithEmail(other, email);
    await other.goto('/dashboard');
    await expect(
      other.locator('.dashboard-home__main h1').first(),
    ).toBeVisible();
    await expect(menuItem(other)).toHaveAccessibleName('What’s new');
    await expect(slip(other)).toHaveCount(0);
  } finally {
    await other.context().close();
  }

  // A newer update shows again.
  await seed(3, {
    text: 'Receipts arrive faster.',
    liveAt: '2026-01-07T10:00:00Z',
  });
  await page.reload();
  await expect(slip(page)).toContainText('Receipts arrive faster.');
  await expect(slip(page)).not.toContainText('more');
});

test('opening What’s new lists entries newest first under their dates, Pro ones say "On Pro"', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await joinedBefore(handle);
  await twoUpdates();
  await seed(3, {
    text: 'Weekly reports show your best day.',
    liveAt: '2026-01-05T08:00:00Z',
  });
  await page.goto('/dashboard');
  await menuItem(page).click();
  await expect(page).toHaveURL(/\/dashboard\/whats-new$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'What’s new' }),
  ).toBeVisible();
  const days = page.locator('.whats-new__day');
  await expect(days.getByRole('heading', { level: 2 })).toHaveText([
    '5 January 2026',
    '3 January 2026',
  ]);
  await expect(days.nth(0).locator('.whats-new__entry')).toHaveText([
    /^On Pro, you can pick a starting amount\.\s*Pro$/,
    'Weekly reports show your best day.',
  ]);
  await expect(days.nth(1).locator('.whats-new__entry')).toHaveText([
    'You can pin a supporter note to your page.',
  ]);
  // Nothing staff wrote reaches the page.
  await expect(page.getByText(/staff title|Staff text/)).toHaveCount(0);
  // Opening the page counts as seeing them: the dot and the slip are gone.
  await expect(menuItem(page)).toHaveAccessibleName('What’s new');
  await expect(menuItem(page)).toHaveAttribute('aria-current', 'page');
  await expectAccessible(page);
  await page.goto('/dashboard');
  await expect(page.locator('.dashboard-home__main h1').first()).toBeVisible();
  await expect(slip(page)).toHaveCount(0);
});

test('a withdrawn entry disappears from What’s new', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await joinedBefore(handle);
  await twoUpdates();
  await page.goto('/dashboard/whats-new');
  await expect(page.locator('.whats-new__entry')).toHaveCount(2);
  const [staff] = await sql<{ id: string }>(
    'SELECT user_id AS id FROM profiles WHERE handle_lower = $1',
    [handle.toLowerCase()],
  );
  await sql(
    `UPDATE changelog_entries
        SET withdrawn_at = now(), withdrawn_by = $2, withdrawn_reason = 'Rolled back'
      WHERE pr_number = $1`,
    [base + 2, staff!.id],
  );
  await page.reload();
  await expect(page.locator('.whats-new__entry')).toHaveText([
    'You can pin a supporter note to your page.',
  ]);
  await expect(page.getByText('starting amount')).toHaveCount(0);
  await expectAccessible(page);
});

test('nothing new: no dot, no slip, and the page says so', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard');
  await expect(page.locator('.dashboard-home__main h1').first()).toBeVisible();
  await expect(menuItem(page)).toHaveAccessibleName('What’s new');
  await expect(slip(page)).toHaveCount(0);
  await menuItem(page).click();
  await expect(page.getByText('Nothing new yet')).toBeVisible();
  await expect(
    page.getByText('Updates to TipMe will show here.'),
  ).toBeVisible();
  await expectAccessible(page);
});

test('on a phone the tab bar keeps four items and What’s new is beside the bell', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 360, height: 800 });
  const { handle } = await signUpRecipient(page, testInfo);
  await joinedBefore(handle);
  await twoUpdates();
  await page.goto('/dashboard');
  const bar = page.getByRole('navigation', { name: 'Dashboard' });
  await expect(bar.getByRole('link')).toHaveText([
    'Home',
    'Tips',
    'My page',
    /^Settings/,
  ]);
  const link = page.locator('.dashboard-bar__whats-new');
  await expect(link).toBeVisible();
  await expect(link).toHaveAccessibleName('What’s new (new updates)');
  const box = (await link.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  // Beside the bell, in the top bar.
  const bell = (await page
    .getByRole('button', { name: /Notifications/ })
    .boundingBox())!;
  expect(
    Math.abs(box.y + box.height / 2 - (bell.y + bell.height / 2)),
  ).toBeLessThan(4);
  await expectAccessible(page);
  await link.click();
  await expect(page).toHaveURL(/\/dashboard\/whats-new$/);
  await expect(page.locator('.whats-new__entry')).toHaveCount(2);
  await expect(link).toHaveAccessibleName('What’s new');
  await expect(
    page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).resolves.toBe(true);
});

test('an API without What’s new: the dashboard looks exactly as before', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await joinedBefore(handle);
  await twoUpdates();
  await page.route('**/v1/me/whats-new/status', (route) =>
    route.fulfill({
      status: 404,
      json: { error: { code: 'NOT_FOUND', message: 'Not found' } },
    }),
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/dashboard');
  await expect(page.locator('.dashboard-home__main h1').first()).toBeVisible();
  await expect(menuItem(page)).toHaveAccessibleName('What’s new');
  await expect(slip(page)).toHaveCount(0);
  // The owner-attention dots may show (a new page has setup to do), never the update one.
  await expect(page.getByText('(new updates)')).toHaveCount(0);
  expect(errors).toEqual([]);
  await expectAccessible(page);
});

test('the public page and the tip form never show What’s new, even with an unseen update', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await joinedBefore(handle);
  await twoUpdates();
  // Signed in as the page's owner, with updates they haven't seen.
  await page.goto('/dashboard');
  await expect(slip(page)).toBeVisible();
  let asked = 0;
  page.on('request', (request) => {
    if (request.url().includes('/v1/me/whats-new')) asked += 1;
  });
  await page.goto(`/@${handle}`);
  await expect(page.getByRole('radio', { name: '2,000 NGN' })).toBeVisible();
  await expect(page.getByText(/What.s new|New in TipMe/)).toHaveCount(0);
  await expect(page.getByText('starting amount')).toHaveCount(0);
  expect(asked).toBe(0);
});
