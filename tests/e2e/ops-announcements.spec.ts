import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, identity, signUpRecipient } from './helpers';
import { E2E_DATABASE_URL } from './stack';
import {
  codeFor,
  enrolOwner,
  secondOwner,
  sql,
  takeGrantedOwners,
} from './ops-helpers';

// Staff announcements by email (owner-approved, 14 Nov 2026): a staff member writes one, previews it
// light and dark, sends themselves a test, asks to send it; a second person approves in Approvals,
// and the screen shows how far the send has gone. Every address is a pretend one (.example).

const fitsWidth = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

/** Staff this test made lose their access again, so no later test finds a second person. */
const revoke = (emails: string[]) =>
  sql(
    `UPDATE staff SET revoked_at = now()
      WHERE revoked_at IS NULL AND user_id IN (SELECT id FROM users WHERE lower(email) = ANY($1))`,
    [emails.map((email) => email.toLowerCase())],
  );

test('staff write an announcement, preview and test it, and a second person approves sending', async ({
  page,
  browser,
}, testInfo) => {
  // Two staff enrol, the worker's 10-second batches, and a stop: more than the default 30 seconds.
  test.setTimeout(90_000);
  const staff: string[] = [];
  try {
    // Someone who turned news and announcements on: the audience is never empty.
    const reader = identity(testInfo);
    const readerEmail = `news.${reader.email}`;
    await sql(
      `WITH made AS (
         INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id
       ) INSERT INTO mail_preferences (user_id, marketing) SELECT id, true FROM made`,
      [readerEmail],
    );
    const subject = `Lower fees on TipMe ${reader.handle}`;

    const first = await enrolOwner(page, testInfo);
    staff.push(first.email);
    await page.goto('/ops/announcements');
    const main = page.getByRole('main');
    await expect(
      main.getByRole('heading', { name: 'Announcements', level: 1 }),
    ).toBeVisible();

    // A change to fees is a service notice: it goes to everyone, with the checklist shown.
    await main.getByRole('radio', { name: /^Service notice/ }).check();
    await expect(
      main.getByText(
        'Only for changes to fees, terms or how TipMe works for the person reading it.',
      ),
    ).toBeVisible();
    await expect(main.getByLabel('Who gets it')).toBeDisabled();
    await main.getByLabel('Subject').fill(subject);
    await main.getByLabel('Preview line').fill('TipMe’s fee is going down.');
    await main
      .getByLabel('Text', { exact: true })
      .fill(
        'From 1 December, TipMe’s fee on each tip is going down.\n\n- **TipMe Free: 7% per tip**\n- **TipMe Pro: 5% per tip**',
      );
    await main.getByLabel('Button label (optional)').fill('See the new fees');
    await main.getByLabel('Button link (optional)').fill('/pro');
    await expectAccessible(page);
    await main.getByRole('button', { name: 'Save draft' }).click();
    await expect(main.getByText('Draft saved.')).toBeVisible();
    await expect(main.getByRole('heading', { name: subject })).toBeVisible();

    // The real email, light and dark.
    await main.getByRole('button', { name: 'Preview' }).click();
    const light = page.frameLocator('iframe[title^="Email preview, light"]');
    const dark = page.frameLocator('iframe[title^="Email preview, dark"]');
    await expect(light.getByRole('heading', { name: subject })).toBeVisible();
    await expect(
      light.locator('strong', { hasText: 'TipMe Free: 7% per tip' }),
    ).toBeVisible();
    await expect(
      light.getByRole('link', { name: 'Email settings' }),
    ).toBeVisible();
    await expect(light.locator('body')).toHaveCSS(
      'background-color',
      'rgb(243, 242, 238)',
    );
    await expect(dark.locator('body')).toHaveCSS(
      'background-color',
      'rgb(20, 18, 16)',
    );

    // A test to the staff member's own address.
    await main.getByRole('button', { name: 'Send a test to me' }).click();
    await expect(main.getByText(/^Test sent to k•••@/)).toBeVisible();
    await expect
      .poll(
        async () =>
          (
            await sql<{ status: string }>(
              `SELECT m.status FROM mail_messages m
                WHERE m.type = 'service_notice' AND m.user_id IS NULL AND m.to_hint = $1
                ORDER BY m.created_at DESC LIMIT 1`,
              [`k•••@${first.email.split('@')[1]}`],
            )
          )[0]?.status,
        { timeout: 20_000 },
      )
      .toBe('sent');

    // Ask: the count is shown, and nothing is sent yet.
    const sendCard = main.locator('.settings-section', {
      has: page.getByRole('heading', { name: 'Send', exact: true }),
    });
    await expect(sendCard.getByTestId('announcement-audience')).toHaveText(
      /Service notice, everyone with a confirmed email: \d[\d,]* (person|people) now\./,
    );
    const second = await secondOwner(browser, testInfo);
    staff.push(second.email);
    await sendCard.getByRole('button', { name: 'Ask to send…' }).click();
    await sendCard
      .getByLabel('Why send this now?')
      .fill('Telling everyone about the new fees');
    await sendCard.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(
      sendCard.getByText('Waiting for a second person', { exact: true }),
    ).toBeVisible({ timeout: 15_000 });
    await expect(main.getByTestId('announcement-progress')).toHaveText(
      'Waiting for approval',
    );
    // This announcement's emails only: under burn-in, another run's service notice (to everyone in
    // this shared database) can already have reached this reader.
    const [ours] = await sql<{ id: string }>(
      `SELECT id FROM announcements WHERE subject = $1`,
      [subject],
    );
    expect(ours?.id).toBeTruthy();
    expect(
      await sql(
        `SELECT 1 FROM mail_messages m JOIN users u ON u.id = m.user_id
          WHERE m.dedupe_key LIKE $2 AND lower(u.email) = lower($1)`,
        [readerEmail, `announcement:${ours!.id}:%`],
      ),
    ).toHaveLength(0);

    // The second person approves in Approvals.
    await second.page.goto('/ops/approvals');
    const card = second.page.getByRole('article').filter({ hasText: subject });
    await expect(
      card.getByText(/^Service notice: goes to everyone\./),
    ).toBeVisible();
    await card.getByRole('button', { name: 'Approve…' }).click();
    await card.getByLabel('Authenticator code').fill(await codeFor(second));
    await card.getByRole('button', { name: 'Approve and run' }).click();
    await expect(card).toHaveCount(0);
    await second.context.close();

    // Progress: "Sending: x of N" once the worker's first batch is queued. A service notice goes to
    // every account in this shared database at the steady rate, so the test stops it from the
    // screen rather than waiting for the last one (the integration tests cover finishing).
    await page.reload();
    await main.getByRole('button', { name: `Open ${subject}` }).click();
    const progress = main.getByTestId('announcement-progress');
    await expect(progress).toHaveText(
      /^(Sending: [1-9][\d,]* of \d[\d,]*|Sent: \d[\d,]* of \d[\d,]* queued)/,
      { timeout: 30_000 },
    );
    if ((await progress.textContent())?.startsWith('Sending')) {
      const stop = main.locator('.settings-section', {
        has: page.getByRole('heading', { name: 'Stop sending' }),
      });
      await stop.getByRole('button', { name: 'Stop sending…' }).click();
      await stop
        .getByLabel('Why stop it?')
        .fill('Enough for this test run, stopping here');
      await stop.getByRole('button', { name: 'Stop sending' }).click();
      await expect(progress).toHaveText(
        /^(Cancelled after \d[\d,]* of \d[\d,]*|Sent: )/,
      );
    }
    const queued = await sql<{ count: number }>(
      `SELECT count(*)::int AS count FROM mail_messages
        WHERE type = 'service_notice' AND category = 'account' AND user_id IS NOT NULL
          AND created_at > now() - interval '5 minutes'`,
    );
    expect(queued[0]?.count).toBeGreaterThan(0);
    await expectAccessible(page);

    await page.setViewportSize({ width: 320, height: 720 });
    await expect(
      main.getByRole('heading', { name: 'Announcements', level: 1 }),
    ).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
  } finally {
    await revoke(staff);
  }
});

test('“News and announcements” in Settings is off until the person turns it on', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#emails');
  const section = page.locator('#emails');
  const news = section.getByLabel('News and announcements');
  await expect(news).not.toBeChecked();
  await news.check();
  await section.getByRole('button', { name: 'Save notifications' }).click();
  await expect(section.getByText('Saved.')).toBeVisible();
  await page.reload();
  await expect(
    page.locator('#emails').getByLabel('News and announcements'),
  ).toBeChecked();
  await expectAccessible(page);
});

// Live progress (docs/superpowers/specs/2026-11-26-live-updates-rest-addendum.md §3.2): while one
// sends, the staff stream's signal re-reads the list instead of a 5 s poll.
//
// Each test seeds its own "sending" announcement and holds a row lock on it (the worker skips a
// locked row), so the worker cannot change it until the test lets go, and nobody gets any mail: its
// cutoff is long past, so the first batch the worker runs finds nobody and finishes it.
type Held = { id: string; release: () => Promise<void> };

async function holdSending(creatorEmail: string): Promise<Held> {
  const ops = await import('../../packages/database/dist/index.js');
  const handle = ops.createDatabase(E2E_DATABASE_URL, { max: 1 });
  const client = await handle.pool.connect();
  const id = randomUUID();
  let released = false;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO announcements
         (id, subject, preheader, text, audience, kind, status, recipient_count, queued_count,
          cutoff, created_by, send_started_at, created_at)
       SELECT $1, $2, 'Live progress', 'Live progress test.', 'everyone', 'service', 'sending', 25, 0,
              '2000-01-01', u.id, now(), now() - interval '10 years'
         FROM users u WHERE lower(u.email) = lower($3)`,
      [id, `Live progress ${id.slice(0, 8)}`, creatorEmail],
    );
    // Committed, then locked again: the row must be visible to the page before the worker may have it.
    await client.query('COMMIT');
    await client.query('BEGIN');
    await client.query('SELECT 1 FROM announcements WHERE id = $1 FOR UPDATE', [
      id,
    ]);
  } catch (error) {
    client.release();
    await handle.close();
    throw error;
  }
  // The database ends a transaction that sits idle for a minute: a query every 10 s keeps this one.
  const keepAlive = setInterval(() => {
    client.query('SELECT 1').catch(() => undefined);
  }, 10_000);
  return {
    id,
    release: async () => {
      if (released) return;
      released = true;
      clearInterval(keepAlive);
      try {
        await client.query('COMMIT');
      } finally {
        client.release();
        await handle.close();
      }
    },
  };
}

/** Stops a test's announcement for good (a lock held, or already finished): nothing mails anybody. */
const settle = (id: string) =>
  sql(
    `UPDATE announcements SET status = 'cancelled', cancelled_at = now()
      WHERE id = $1 AND status = 'sending'`,
    [id],
  );

type Seen = { type: string; at: number };

/** Records each stream message with its page time, so a read a signal caused is told from a timed one. */
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

/** Page times of the list reads (`/v1/ops/announcements`, no sub-path), and of the stream messages. */
const timeline = (page: Page) =>
  page.evaluate(() => ({
    reads: performance
      .getEntriesByType('resource')
      .filter((entry) => /\/v1\/ops\/announcements(\?|$)/.test(entry.name))
      .map((entry) => entry.startTime),
    live: (window as unknown as { __live?: Seen[] }).__live ?? [],
  }));

test.describe('live progress', () => {
  test.beforeEach(() => {
    takeGrantedOwners();
  });
  test.afterEach(async () => {
    await revoke(takeGrantedOwners());
  });

  test('a sending count moves without the 5 s poll while connected', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await recordStream(page);
    const owner = await enrolOwner(page, testInfo);
    const held = await holdSending(owner.email);
    try {
      await page.goto('/ops/announcements');
      await expect(page.locator('[data-live="connected"]')).toBeAttached({
        timeout: 15_000,
      });
      const main = page.getByRole('main');
      await main
        .getByRole('button', {
          name: `Open Live progress ${held.id.slice(0, 8)}`,
        })
        .click();
      const progress = main.getByTestId('announcement-progress');
      await expect(progress).toHaveText(
        /^(Sending|Paused for the daily limit): 0 of 25/,
      );

      await page.waitForTimeout(30_000);
      await expect(page.locator('[data-live="connected"]')).toBeAttached();
      const { reads, live } = await timeline(page);
      const ready = live.filter((m) => m.type === 'ready').map((m) => m.at);
      const signals = live
        .filter((m) => m.type === 'ops.announcements.changed')
        .map((m) => m.at);
      // Beyond the first read, a read follows a signal (another test's batch) or is a ready's resync.
      const [, ...rest] = reads;
      const timed = rest.filter(
        (at) =>
          !signals.some((s) => at >= s - 50 && at - s < 2000) &&
          !ready.some((r) => at >= r - 50 && at - r < 1000),
      );
      expect(timed).toEqual([]);

      // Let the worker have it: its next tick queues the batch, signals, and the text changes.
      await held.release();
      await expect
        .poll(
          async () =>
            (
              await sql<{ status: string }>(
                `SELECT status FROM announcements WHERE id = $1`,
                [held.id],
              )
            )[0]?.status,
          { timeout: 25_000, intervals: [200] },
        )
        .toBe('sent');
      await expect(progress).toHaveText(/^Sent: 0 of 25 queued/, {
        timeout: 5000,
      });
    } finally {
      await held.release();
      await settle(held.id);
    }
  });

  test('with the stream refused the sending list reads every 30 s, not 5 s', async ({
    page,
  }, testInfo) => {
    test.setTimeout(150_000);
    const owner = await enrolOwner(page, testInfo);
    const held = await holdSending(owner.email);
    try {
      await page.route('**/v1/ops/events', (route) => route.abort());
      await page.goto('/ops/announcements');
      await expect(
        page.getByRole('heading', { name: 'Announcements', level: 1 }),
      ).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: `Open Live progress ${held.id.slice(0, 8)}`,
        }),
      ).toBeVisible();
      await page.waitForTimeout(70_000);
      await expect(page.locator('[data-live="polling"]')).toBeAttached();

      const { reads } = await timeline(page);
      expect(reads.length - 1).toBeGreaterThanOrEqual(2);
      expect(reads.length - 1).toBeLessThanOrEqual(3);
      for (let i = 1; i < reads.length; i += 1)
        expect(reads[i]! - reads[i - 1]!).toBeGreaterThanOrEqual(27_000);
    } finally {
      await held.release();
      await settle(held.id);
    }
  });

  test('with live off the page polls every 5 s while sending', async ({
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    const owner = await enrolOwner(page, testInfo);
    const held = await holdSending(owner.email);
    try {
      // The real answer, with live updates off.
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
      await page.goto('/ops/announcements');
      await expect(
        page.getByRole('button', {
          name: `Open Live progress ${held.id.slice(0, 8)}`,
        }),
      ).toBeVisible();
      // No stream at all: the page's own timer is the only refresh.
      await expect(page.locator('[data-live="idle"]')).toBeAttached();
      await page.waitForTimeout(22_000);

      const { reads } = await timeline(page);
      const timed = reads.slice(1);
      expect(timed.length).toBeGreaterThanOrEqual(3);
      expect(timed.length).toBeLessThanOrEqual(5);
      for (let i = 1; i < reads.length; i += 1) {
        const gap = reads[i]! - reads[i - 1]!;
        expect(gap).toBeGreaterThanOrEqual(4000);
        expect(gap).toBeLessThanOrEqual(7000);
      }
    } finally {
      await held.release();
      await settle(held.id);
    }
  });
});
