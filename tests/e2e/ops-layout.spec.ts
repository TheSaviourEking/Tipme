import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { enrolOwner, sql } from './ops-helpers';

// The admin UI audit (15 Nov 2026, F1–F26): every admin page shares one page root, nothing scrolls
// sideways at 320, 390 or 1440, wide tables become stacked cards on a phone, and purple stays the
// signature (never a state colour). Docs: docs/design/DECISION-LOG.md, 2026-11-15.

const WIDTHS = [320, 390, 1440];
const SIGNATURE = 'rgb(122, 50, 249)';

/** How far the page, and each table's own scrolling region, run past their width. */
const overflow = (page: Page) =>
  page.evaluate(() => ({
    page:
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
    tables: [...document.querySelectorAll('.ops-table-wrap')].map(
      (wrap) => wrap.scrollWidth - wrap.clientWidth,
    ),
  }));

test('admin pages fit 320, 390 and 1440 with one page root, and tables stack on a phone', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  await enrolOwner(page, testInfo);
  // A long unbroken audit reason (a pasted link), so the audit table has something to wrap whatever
  // else the shared database holds.
  await sql(
    `INSERT INTO audit_events (id, action, subject_type, subject_id, reason, created_at)
     VALUES (gen_random_uuid(), 'staff.owner_granted_with_a_rather_long_action_name', 'ops_session_subject',
             gen_random_uuid()::text, $1, now() + interval '1 day')`,
    [`Checked https://example.com/${'a1b2c3d4'.repeat(30)} first`],
  );
  // A switch change, whose record the log writes in words (never its JSON).
  const why = `Pilot group ${randomBytes(3).toString('hex')}`;
  await sql(
    `INSERT INTO audit_events (id, action, subject_type, subject_id, reason, created_at)
     VALUES (gen_random_uuid(), 'feature_switch.set', 'feature_switch', 'page_studio', $1,
             now() + interval '1 day')`,
    [
      `${why} [change: ${JSON.stringify({ from: false, to: true, approvedBy: null })}]`,
    ],
  );
  // A long name and address, so the People table has something to wrap.
  const token = `w${randomBytes(3).toString('hex')}`;
  await sql(
    `WITH made AS (
       INSERT INTO users (id, email) VALUES (gen_random_uuid(), $1 || '.a.very.long.address@example.com')
       RETURNING id)
     INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state, plan)
     SELECT gen_random_uuid(), made.id, $1, $1, 'Oluwaseun Adebayo-Williamson of Lagos Island', 'live', 'free'
       FROM made`,
    [token],
  );
  for (const path of [
    '/ops',
    '/ops/audit',
    '/ops/usernames',
    '/ops/users',
    '/ops/switches',
    '/ops/email',
    '/ops/providers',
    '/ops/providers/confirm',
    // You collect (Task 15): its staff screens.
    '/ops/collect',
    '/ops/collect/held',
    '/ops/collect/transfers',
    '/ops/collect/disputes',
    '/ops/collect/reserve',
    '/ops/collect/unclaimed',
    '/ops/collect/settings',
  ]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(path);
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
    // One root, whatever the page (Email and Providers once returned bare fragments).
    await expect(main.locator(':scope > .ops-page-body')).toHaveCount(1);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await expect
        .poll(async () => (await overflow(page)).page, {
          message: `${path} at ${width}px scrolls sideways`,
        })
        .toBe(0);
      const { tables } = await overflow(page);
      for (const extra of tables)
        expect(extra, `${path} at ${width}px: a table scrolls`).toBeLessThan(2);
    }
  }

  // The audit log on a phone: each row is a card whose fields carry their names.
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto('/ops/audit');
  const firstCell = page.locator('.ops-table--stack tbody td').first();
  await expect(firstCell).toBeVisible();
  expect(
    await firstCell.evaluate((el) => getComputedStyle(el, '::before').content),
  ).toBe('"When"');

  const reason = page
    .getByRole('region', { name: 'Audit entries' })
    .getByRole('cell')
    .filter({ hasText: why });
  await expect(reason).toContainText('Switch page_studio: off → on');
  await expect(reason).not.toContainText('{');
});

test('purple is never a state: recessed tiles, a green lamp, plain radio rows, black actions', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);

  await page.goto('/ops');
  const tile = page.locator('.ops-tile').first();
  await expect(tile).toBeVisible();
  await expect(tile).toHaveCSS('background-color', 'rgb(238, 237, 232)');
  await expect(tile).toHaveCSS('box-shadow', /inset/);
  const stop = page
    .getByTestId('withdrawals-switch')
    .getByRole('button', { name: 'Switch off all withdrawals…' });
  await stop.click();
  await expect(
    page
      .getByTestId('withdrawals-switch')
      .getByRole('button', { name: 'Switch off', exact: true }),
  ).not.toHaveCSS('background-color', SIGNATURE);

  await page.goto('/ops/switches');
  const lamps = page
    .getByRole('main')
    .locator('[data-testid="switch-state"] .tm-lamp');
  await expect(lamps.first()).toBeVisible();
  for (const lamp of await lamps.all())
    await expect(lamp).not.toHaveCSS('background-color', SIGNATURE);

  // Who sees a changelog entry: radio rows with their hint beside them, not amount keys.
  const number = randomInt(100_000, 2_000_000_000);
  await sql(
    `INSERT INTO changelog_entries (pr_number, merge_sha, merged_at, pr_title, staff_text, user_text, audience)
     VALUES ($1, $2, now() + interval '1 year', 'Layout check', 'Layout check', 'You can pin a note.', 'everyone')`,
    [number, randomBytes(20).toString('hex')],
  );
  await page.goto(`/ops/changelog/${number}`);
  const group = page.getByRole('group', { name: 'Who sees it' });
  const everyone = group.getByRole('radio', { name: /^Everyone/ });
  await expect(everyone).toBeChecked();
  await expect(everyone).toHaveCSS('accent-color', SIGNATURE);
  const hint = group.getByText('Every page.', { exact: true });
  await expect(hint).toHaveCSS('border-top-width', '0px');
  await expect(hint).toHaveCSS('box-shadow', 'none');
  // Every target in the row is at least 44px tall.
  const row = await group.locator('label').first().boundingBox();
  expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
});
