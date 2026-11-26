import { expect, test, type Page } from '@playwright/test';
import { signUpRecipient } from './helpers';
import {
  enrolOwner,
  mismatchedTip,
  secondOwner,
  sql,
  takeGrantedOwners,
} from './ops-helpers';

// Live updates for the admin area (docs/superpowers/specs/2026-11-26-live-updates-rest-addendum.md
// §3.1, §3.4): the staff stream re-reads approvals and issues on a signal, a connected screen makes
// no timed requests, and a stream that can't connect falls back to a 30 s ± 3 s poll. 5 s is well
// under that fallback, so passing within it means the stream did it.
const LIVE_BOUND_MS = 5000;
const REASON = 'Checked with the person on a call today';

// Every pending request mails everyone who could decide it, so each test's owners go when it ends
// (as in ops-staff.spec.ts): exactly the addresses it granted.
test.beforeEach(() => {
  takeGrantedOwners();
});
test.afterEach(async () => {
  const emails = takeGrantedOwners();
  if (emails.length === 0) return;
  await sql(
    `UPDATE staff s SET revoked_at = now() FROM users u
      WHERE u.id = s.user_id AND s.revoked_at IS NULL
        AND lower(u.email) = ANY($1::text[])`,
    [emails.map((email) => email.toLowerCase())],
  );
});

type Seen = { type: string; at: number };

/**
 * Records every stream message with its page time, so a test can tell a read a signal caused from
 * a timed one: other workers' issues signal this staff member too.
 */
async function recordStream(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __live: Seen[] };
    w.__live = [];
    const Native = window.EventSource;
    window.EventSource = class extends Native {
      constructor(url: string | URL, init?: EventSourceInit) {
        super(url, init);
        this.addEventListener('message', (event) => {
          try {
            const type = (JSON.parse(String(event.data)) as { type: string })
              .type;
            w.__live.push({ type, at: performance.now() });
          } catch {
            // Not ours to judge: the client ignores it too.
          }
        });
      }
    };
  });
}

/** Page times of the issues list reads (`/v1/ops/issues?…`), and of the stream messages. */
const timeline = (page: Page) =>
  page.evaluate(() => ({
    reads: performance
      .getEntriesByType('resource')
      .filter((entry) => /\/v1\/ops\/issues\?/.test(entry.name))
      .map((entry) => entry.startTime),
    live: (window as unknown as { __live?: Seen[] }).__live ?? [],
  }));

const markNoReload = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __noReload: number }).__noReload = 1;
  });
const noReload = (page: Page) =>
  page.evaluate(
    () => (window as unknown as { __noReload?: number }).__noReload,
  );

test('a second approver sees a new request without reloading', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const recipient = await browser.newContext();
  const { handle } = await signUpRecipient(await recipient.newPage(), testInfo);
  await recipient.close();
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);
  await other.page.goto('/ops/approvals');
  await expect(other.page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  await expect(
    other.page.getByRole('heading', { name: 'Waiting', exact: true }),
  ).toBeVisible();
  await markNoReload(other.page);

  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByRole('button', { name: 'Set this page’s fee…' }).click();
  await page.getByLabel('New TipMe fee (%)').fill('4');
  await page
    .locator('form')
    .filter({ has: page.getByLabel('New TipMe fee (%)') })
    .getByLabel('Reason')
    .fill(REASON);
  await page.getByRole('button', { name: 'Set this page’s fee' }).click();
  await expect(
    page.getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible();

  const card = other.page
    .getByRole('article')
    .filter({ hasText: `@${handle}` });
  await expect(card.getByRole('button', { name: 'Approve…' })).toBeVisible({
    timeout: LIVE_BOUND_MS,
  });
  expect(await noReload(other.page)).toBe(1);
  // The menu's count read again on the same signal: it counts what this person could decide,
  // which other workers' requests may add to, so it matches the list rather than a fixed number.
  const link = other.page
    .getByRole('navigation', { name: 'Admin' })
    .getByRole('link', { name: /^Approvals/ });
  await expect(async () => {
    const decidable = await other.page
      .getByRole('button', { name: 'Approve…' })
      .count();
    expect(decidable).toBeGreaterThanOrEqual(1);
    await expect(link).toHaveAccessibleName(
      `Approvals (${decidable} waiting for you)`,
      { timeout: 500 },
    );
  }).toPass({ timeout: LIVE_BOUND_MS });
  expect(await noReload(other.page)).toBe(1);
  await other.context.close();
});

test('issues make no timed requests while connected', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  await recordStream(page);
  await enrolOwner(page, testInfo);
  await page.goto('/ops/issues');
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await page.waitForTimeout(65_000);
  await expect(page.locator('[data-live="connected"]')).toBeAttached();

  const { reads, live } = await timeline(page);
  const ready = live.filter((m) => m.type === 'ready').map((m) => m.at);
  const signals = live
    .filter((m) => m.type === 'ops.issues.changed')
    .map((m) => m.at);
  expect(ready.length).toBeGreaterThanOrEqual(1);
  // Beyond the first read, a read must follow a signal (another worker's issue) within its
  // debounce, or be a ready's resync (at most one per ready): none comes from a timer.
  const [, ...rest] = reads;
  const others = rest.filter(
    (at) => !signals.some((s) => at >= s - 50 && at - s < 2000),
  );
  const afterReady = others.filter((at) =>
    ready.some((r) => at >= r - 50 && at - r < 1000),
  );
  const timed = others.filter((at) => !afterReady.includes(at));
  expect(afterReady.length).toBeLessThanOrEqual(ready.length);
  expect(timed).toEqual([]);
});

test('issues fall back to 30 s when the stream is refused', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  await enrolOwner(page, testInfo);
  await page.route('**/v1/ops/events', (route) => route.abort());
  await page.goto('/ops/issues');
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect.poll(async () => (await timeline(page)).reads.length).toBe(1);
  await page.waitForTimeout(70_000);
  await expect(page.locator('[data-live="polling"]')).toBeAttached();

  const { reads } = await timeline(page);
  const after = reads.slice(1);
  expect(after.length).toBeGreaterThanOrEqual(2);
  expect(after.length).toBeLessThanOrEqual(3);
  for (let i = 1; i < reads.length; i += 1)
    expect(reads[i] - reads[i - 1]).toBeGreaterThanOrEqual(27_000);
});

test('a new issue appears without reloading', async ({
  page,
  browser,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const recipient = await browser.newContext();
  const { handle } = await signUpRecipient(await recipient.newPage(), testInfo);
  await recipient.close();
  await enrolOwner(page, testInfo);
  await page.goto('/ops/issues');
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await markNoReload(page);

  const issueId = await mismatchedTip(request, handle);
  await expect(page.locator(`a[href="/ops/issues/${issueId}"]`)).toBeVisible({
    timeout: LIVE_BOUND_MS,
  });
  expect(await noReload(page)).toBe(1);
});
