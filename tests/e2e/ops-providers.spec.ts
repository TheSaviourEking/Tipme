import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport } from './helpers';
import {
  enrolOwner,
  noOtherStaff,
  sql,
  takeGrantedOwners,
  withDatabase,
} from './ops-helpers';

// Only the pretend provider is configured in e2e, and it is the default. Choosing a provider
// without keys here means no card is active, so the pretend one can be switched to.
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  await withDatabase(async (db) => {
    const run = db as { execute(sql: string): Promise<unknown> };
    await run.execute('DELETE FROM provider_tests');
    await run.execute(
      `INSERT INTO provider_settings (kind, active_provider, changed_at, reason)
       VALUES ('mail', 'zeptomail', now(), 'e2e setup')
       ON CONFLICT (kind) DO UPDATE SET active_provider = 'zeptomail'`,
    );
  });
});
test.afterAll(async () => {
  await withDatabase(async (db) => {
    await (db as { execute(sql: string): Promise<unknown> }).execute(
      "DELETE FROM provider_settings WHERE kind = 'mail'",
    );
  });
});

const linkIn = (text: string | null) =>
  /(\/ops\/providers\/confirm\S*#t=[\w-]+)/.exec(text ?? '')?.[1] ?? '';

/** The newest test email's link in the pretend inbox now, or '' when there is none yet. */
async function newestTestLinkNow(page: import('@playwright/test').Page) {
  const inbox = await page.context().newPage();
  await inbox.goto('/dev/inbox');
  // The inbox loads in the browser; signing in left a code there, so wait for that first.
  await expect(inbox.getByRole('article').first()).toBeVisible();
  const mails = inbox
    .getByRole('article')
    .filter({ hasText: 'TipMe mail test' });
  const link = (await mails.count())
    ? linkIn(await mails.first().textContent())
    : '';
  await inbox.close();
  return link;
}

/**
 * The newest test email's link, reloading the pretend inbox until one arrives that isn't `seen`.
 * A repeated run finds the last run's mail (its link already used) until the new one lands.
 */
async function testEmailLink(page: import('@playwright/test').Page, seen = '') {
  const inbox = await page.context().newPage();
  const mail = inbox
    .getByRole('article')
    .filter({ hasText: 'TipMe mail test' })
    .first();
  let link = '';
  await expect(async () => {
    await inbox.goto('/dev/inbox');
    await expect(mail).toBeVisible({ timeout: 1000 });
    link = linkIn(await mail.textContent());
    expect(link).not.toBe('');
    expect(link).not.toBe(seen);
  }).toPass({ timeout: 25_000 });
  await inbox.close();
  return link;
}

test('@alone staff send a test, confirm it from the inbox, and make the provider active', async ({
  page,
}, testInfo) => {
  await noOtherStaff();
  await enrolOwner(page, testInfo);
  await page.goto('/ops/providers');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Providers' }),
  ).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  const card = page.getByTestId('provider-mock');
  // Make active is unavailable until a test is confirmed.
  await expect(card.getByRole('button', { name: 'Make active' })).toHaveCount(
    0,
  );
  await card.getByRole('button', { name: 'Send test' }).click();
  await card.getByLabel('Send the test to').fill('staff@example.com');
  await card
    .getByLabel('Why are you testing this provider?')
    .fill('Checking mail before launch');
  const seen = await newestTestLinkNow(page);
  await card.getByRole('button', { name: 'Send the test email' }).click();
  await expect(card.getByText(/Test sent to s•••@example\.com/)).toBeVisible();

  // A signed-out staff member opening the link comes back to it after signing in.
  const link = await testEmailLink(page, seen);
  await page.goto(link);
  // The confirm page waits on one POST; a loaded runner has taken over 5 s (burn-in, 26 Nov 2026).
  await expect(page.getByText(/Test confirmed/)).toBeVisible({
    timeout: 15_000,
  });
  await expectAccessible(page);

  await page.goto('/ops/providers');
  const ready = page.getByTestId('provider-mock');
  await expect(ready.getByText(/Confirmed/)).toBeVisible();
  await ready.getByRole('button', { name: 'Make active' }).click();
  await ready
    .getByLabel('Why are you switching?')
    .fill('Confirmed by test, using it now');
  await ready.getByRole('button', { name: 'Switch provider' }).click();
  await expect(ready.getByText('Active', { exact: true })).toBeVisible();
});

test('@alone an override can be set and removed with a reason (needs the confirmed test above)', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.goto('/ops/providers');
  await page.getByLabel('Provider', { exact: true }).selectOption('mock');
  await page.getByLabel('Account (username or user id)').fill('tobi');
  await page
    .getByLabel('Why does this account need its own provider?')
    .fill('Their mailbox rejects the main provider');
  await page.getByRole('button', { name: 'Pin account' }).click();
  const row = page.getByTestId('override-tobi');
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Remove' }).click();
  await row.getByLabel('Why remove this pin?').fill('No longer needed here');
  await row.getByRole('button', { name: 'Remove pin' }).click();
  await expect(row).toHaveCount(0);
});

// Live providers screen (docs/superpowers/specs/2026-11-26-live-updates-rest-addendum.md §3.3): while
// connected, a test settling or being confirmed signals the page, and a resting provider's `until`
// (which no write marks) is one timeout, not a 5 s poll.

type Seen = { type: string; at: number };

/** Records each stream message with its wall-clock time, so a read a message caused is told apart. */
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
            w.__live.push({
              type,
              at: performance.timeOrigin + performance.now(),
            });
          } catch {
            // Not ours to judge: the client ignores it too.
          }
        });
      }
    };
  });
}

const liveMessages = (page: Page) =>
  page.evaluate(() => (window as unknown as { __live?: Seen[] }).__live ?? []);

/** Each read of the providers page, timed where it leaves the browser (wall clock, as the stream's). */
async function countReads(
  page: Page,
  answer?: (
    route: import('@playwright/test').Route,
    index: number,
  ) => Promise<void>,
) {
  const reads: number[] = [];
  await page.route('**/v1/ops/providers/mail', async (route) => {
    reads.push(Date.now());
    if (answer) await answer(route, reads.length - 1);
    else await route.continue();
  });
  return reads;
}

/** The reads a stream message explains: a ready's resync, or a signal's re-read (4 s, as Task 4). */
function unexplained(reads: number[], live: Seen[]) {
  const ready = live.filter((m) => m.type === 'ready').map((m) => m.at);
  const signals = live
    .filter((m) => m.type === 'ops.providers.changed')
    .map((m) => m.at);
  return reads.filter(
    (at) =>
      !ready.some((r) => at >= r - 50 && at - r < 1500) &&
      !signals.some((s) => at >= s - 50 && at - s < 4000),
  );
}

const sentCount = async (card: import('@playwright/test').Locator) =>
  Number(
    /Last 24 hours: (\d+) sent/.exec((await card.textContent()) ?? '')?.[1] ??
      NaN,
  );

test('@alone a pending test does not poll every 5 s while connected', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  await recordStream(page);
  await enrolOwner(page, testInfo);
  const reads = await countReads(page);
  await page.goto('/ops/providers');
  await expect(page.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  const card = page.getByTestId('provider-mock');
  await expect(card).toContainText(/Last 24 hours: \d+ sent/);
  const sentBefore = await sentCount(card);
  const seen = await newestTestLinkNow(page);

  await card.getByRole('button', { name: 'Send test' }).click();
  await card.getByLabel('Send the test to').fill('staff@example.com');
  await card
    .getByLabel('Why are you testing this provider?')
    .fill('Checking the live Providers page');
  await card.getByRole('button', { name: 'Send the test email' }).click();
  await expect(card.getByText(/Test sent to s•••@example\.com/)).toBeVisible();

  // The pretend mail settles: the worker signals, and the card's sent count moves within 5 s.
  await expect
    .poll(
      async () =>
        (
          await sql<{ status: string }>(
            `SELECT status FROM mail_messages WHERE type = 'provider_test'
              ORDER BY created_at DESC LIMIT 1`,
          )
        )[0]?.status,
      { timeout: 20_000, intervals: [200] },
    )
    .toBe('sent');
  await expect(async () => {
    expect(await sentCount(card)).toBeGreaterThan(sentBefore);
  }).toPass({ timeout: 5000 });
  expect(
    (await liveMessages(page)).some((m) => m.type === 'ops.providers.changed'),
  ).toBe(true);

  // The test still waits for its link: today's page read every 5 s for this. Connected, none.
  const from = Date.now();
  await page.waitForTimeout(30_000);
  await expect(page.locator('[data-live="connected"]')).toBeAttached();
  expect(
    unexplained(
      reads.filter((at) => at > from),
      await liveMessages(page),
    ),
  ).toEqual([]);

  // Confirmed in another tab: the API signals, and this card says so within 5 s.
  await expect(card.getByText(/Confirmed/)).toHaveCount(0);
  const link = await testEmailLink(page, seen);
  const other = await page.context().newPage();
  try {
    await other.goto(link);
    await expect(other.getByText(/Test confirmed/)).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    await other.close();
  }
  await expect(card.getByText(/Confirmed/)).toBeVisible({ timeout: 5000 });
});

/** The real answer, with the pretend provider resting until `until`: the same body for every read. */
type ProvidersBody = { data: { providers: Array<Record<string, unknown>> } };

function restingAnswer() {
  let body: ProvidersBody | null = null;
  let until = 0;
  return {
    until: () => until,
    answer: async (route: import('@playwright/test').Route) => {
      const response = await route.fetch();
      if (!body) {
        until = Date.now() + 8000;
        const real = (await response.json()) as ProvidersBody;
        body = {
          ...real,
          data: {
            ...real.data,
            providers: real.data.providers.map((card) =>
              card['name'] === 'mock'
                ? {
                    ...card,
                    health: {
                      state: 'resting',
                      kind: 'send',
                      until: new Date(until).toISOString(),
                      reason: '3 send failures in 5 min (last: http_503)',
                      trippedAt: new Date(until - 900_000).toISOString(),
                    },
                  }
                : card,
            ),
          },
        };
      }
      await route.fulfill({ response, json: body });
    },
  };
}

test.describe('a resting provider', () => {
  test.beforeEach(() => {
    takeGrantedOwners();
  });
  test.afterEach(async () => {
    const emails = takeGrantedOwners();
    // Staff this test made lose their access again, so no later test finds a second person.
    await sql(
      `UPDATE staff SET revoked_at = now()
        WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE lower(email) = ANY($1))`,
      [emails.map((email) => email.toLowerCase())],
    );
  });

  test('a resting provider re-reads once at its until', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await recordStream(page);
    await enrolOwner(page, testInfo);
    const resting = restingAnswer();
    const reads = await countReads(page, resting.answer);
    await page.goto('/ops/providers');
    await expect(
      page.getByTestId('provider-mock').getByText(/^Resting until /),
    ).toBeVisible();
    await expect(page.locator('[data-live="connected"]')).toBeAttached({
      timeout: 15_000,
    });
    const until = resting.until();
    // Past the latest the one re-read may come (8 s, plus up to 5 s of jitter), and 2 s more.
    await page.waitForTimeout(Math.max(0, until + 8000 - Date.now()));
    await expect(page.locator('[data-live="connected"]')).toBeAttached();

    // The first read set `until`; the ready's resync is the stream's. What is left is the timer's.
    const timed = unexplained(reads.slice(1), await liveMessages(page));
    expect(timed.filter((at) => at < until)).toEqual([]);
    expect(
      timed.filter((at) => at >= until && at <= until + 6000),
    ).toHaveLength(1);
    expect(timed.filter((at) => at > until + 6000)).toEqual([]);
  });

  test('with live off a resting provider reads every 5 s', async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await enrolOwner(page, testInfo);
    // The real answer, with live updates off: no stream, so the page's own timer.
    await page.route('**/v1/ops/me', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as {
        data: Record<string, unknown>;
      };
      await route.fulfill({
        response,
        json: { ...body, data: { ...body.data, liveUpdates: false } },
      });
    });
    const reads = await countReads(page, restingAnswer().answer);
    await page.goto('/ops/providers');
    await expect(
      page.getByTestId('provider-mock').getByText(/^Resting until /),
    ).toBeVisible();
    await expect(page.locator('[data-live="idle"]')).toBeAttached();
    await page.waitForTimeout(17_000);

    const timed = reads.slice(1);
    expect(timed.length).toBeGreaterThanOrEqual(3);
    expect(timed.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < reads.length; i += 1) {
      const gap = reads[i]! - reads[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(4000);
      expect(gap).toBeLessThanOrEqual(7000);
    }
  });
});
