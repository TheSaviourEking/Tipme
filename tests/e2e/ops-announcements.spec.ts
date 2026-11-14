import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, identity } from './helpers';
import { codeFor, enrolOwner, secondOwner, sql } from './ops-helpers';

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
                WHERE m.type = 'announcement' AND m.user_id IS NULL AND m.to_hint = $1
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
      /Everyone with a confirmed email: \d[\d,]* (person|people) now\./,
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
    expect(
      await sql(
        `SELECT 1 FROM mail_messages m JOIN users u ON u.id = m.user_id
          WHERE m.type = 'announcement' AND lower(u.email) = lower($1)`,
        [readerEmail],
      ),
    ).toHaveLength(0);

    // The second person approves in Approvals.
    await second.page.goto('/ops/approvals');
    const card = second.page.getByRole('article').filter({ hasText: subject });
    await card.getByRole('button', { name: 'Approve…' }).click();
    await card.getByLabel('Authenticator code').fill(await codeFor(second));
    await card.getByRole('button', { name: 'Approve and run' }).click();
    await expect(card).toHaveCount(0);
    await second.context.close();

    // Progress: "Sending: x of N", then every email queued.
    await page.reload();
    await main.getByRole('button', { name: `Open ${subject}` }).click();
    await expect(main.getByTestId('announcement-progress')).toHaveText(
      /^(Sending: \d[\d,]* of \d[\d,]*|Sent: \d[\d,]* of \d[\d,]* queued)/,
    );
    await expect(main.getByTestId('announcement-progress')).toHaveText(
      /^Sent: \d[\d,]* of \d[\d,]* queued/,
      { timeout: 60_000 },
    );
    await expect
      .poll(
        async () =>
          (
            await sql(
              `SELECT 1 FROM mail_messages m JOIN users u ON u.id = m.user_id
                WHERE m.type = 'announcement' AND m.category = 'marketing' AND lower(u.email) = lower($1)`,
              [readerEmail],
            )
          ).length,
        { timeout: 20_000 },
      )
      .toBe(1);
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
