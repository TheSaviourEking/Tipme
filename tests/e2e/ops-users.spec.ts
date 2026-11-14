import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { enrolOwner, openOpsLink, sql } from './ops-helpers';

// People (owner's ask, 14 Nov 2026; OpsUsers board): every account, as a list or a grid, a page at
// a time, all state in the address. The database holds other tests' accounts, so every assertion
// is scoped to accounts this test made (a unique token in their handles), never to a total.

const REASON = 'Checking who owns this account for a ticket';

/** `count` accounts with pages, newest first by index: `${token}00` is the newest. One statement. */
async function seedAccounts(
  token: string,
  count: number,
  options: { pro?: number[]; offline?: number[] } = {},
) {
  await sql(
    `WITH made AS (
       INSERT INTO users (id, email, created_at)
       SELECT gen_random_uuid(), $1 || g || '@example.com', now() - make_interval(secs => g + 60)
         FROM generate_series(0, $2::int - 1) g
       RETURNING id, email
     )
     INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state, plan)
     SELECT gen_random_uuid(), made.id, h.handle, h.handle, 'Person ' || h.handle,
            CASE WHEN h.g = ANY ($4::int[]) THEN 'not_live' ELSE 'live' END,
            CASE WHEN h.g = ANY ($3::int[]) THEN 'pro' ELSE 'free' END
       FROM made
       CROSS JOIN LATERAL (
         SELECT substring(made.email FROM length($1) + 1 FOR position('@' IN made.email) - length($1) - 1)::int AS g
       ) n
       CROSS JOIN LATERAL (SELECT n.g, $1 || lpad(n.g::text, 2, '0') AS handle) h`,
    [token, count, options.pro ?? [], options.offline ?? []],
  );
}

const results = (page: Page) => page.getByTestId('ops-people');
const pager = (page: Page) => page.getByRole('navigation', { name: 'Pages' });
const rowFor = (page: Page, handle: string) =>
  results(page)
    .getByRole('row')
    .filter({ hasText: `@${handle}` });
const cardFor = (page: Page, handle: string) =>
  results(page)
    .getByRole('listitem')
    .filter({ hasText: `@${handle}` });

test('list: pages turn by link, number and Back, 50 per page keeps the first in view, and it passes axe', async ({
  page,
}, testInfo) => {
  const token = `pl${randomUUID().slice(0, 6)}`;
  await seedAccounts(token, 30);
  await enrolOwner(page, testInfo);
  await openOpsLink(page, 'People');
  await expect(page).toHaveURL(/\/ops\/users$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'People' }),
  ).toBeVisible();

  await page.getByLabel('Search', { exact: true }).fill(token);
  await expect(page).toHaveURL(new RegExp(`q=${token}`));
  await expect(rowFor(page, `${token}00`)).toBeVisible();
  await expect(rowFor(page, `${token}24`)).toBeVisible();
  await expect(rowFor(page, `${token}25`)).toHaveCount(0);
  await expect(pager(page).getByText('Showing 1–25 of 30')).toBeVisible();
  await expect(
    pager(page).getByRole('link', { name: 'Page 1' }),
  ).toHaveAttribute('aria-current', 'page');
  await expectAccessible(page);

  // Next, a page number, Previous, Back: the address and the rows follow.
  await pager(page).getByRole('link', { name: 'Next ›' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(rowFor(page, `${token}25`)).toBeVisible();
  await expect(rowFor(page, `${token}29`)).toBeVisible();
  await expect(rowFor(page, `${token}00`)).toHaveCount(0);
  await expect(pager(page).getByText('Showing 26–30 of 30')).toBeVisible();
  await expect(pager(page).getByText('Next ›')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await pager(page).getByRole('link', { name: '‹ Previous' }).click();
  await expect(page).not.toHaveURL(/page=2/);
  await expect(rowFor(page, `${token}00`)).toBeVisible();
  await pager(page).getByRole('link', { name: 'Page 2' }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(rowFor(page, `${token}29`)).toBeVisible();
  await page.goBack();
  await expect(page).not.toHaveURL(/page=2/);
  await expect(rowFor(page, `${token}00`)).toBeVisible();

  // 50 per page keeps the first account in view on one page.
  await pager(page).getByLabel('Per page').selectOption('50');
  await expect(page).toHaveURL(/perPage=50/);
  await expect(rowFor(page, `${token}29`)).toBeVisible();
  await expect(pager(page).getByText('Showing 1–30 of 30')).toBeVisible();
});

test('grid: remembered across a reload, a card opens the page, and it passes axe', async ({
  page,
}, testInfo) => {
  const token = `pg${randomUUID().slice(0, 6)}`;
  await seedAccounts(token, 4);
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/users?q=${token}`);
  await expect(rowFor(page, `${token}00`)).toBeVisible();

  // Grid, remembered across a reload (it is not in the address).
  await page
    .getByRole('group', { name: 'View' })
    .getByRole('button', { name: 'Grid' })
    .click();
  await expect(cardFor(page, `${token}00`)).toBeVisible();
  await expect(results(page).getByRole('table')).toHaveCount(0);
  await expectAccessible(page);
  await page.reload();
  await expect(cardFor(page, `${token}00`)).toBeVisible();
  await expect(
    page
      .getByRole('group', { name: 'View' })
      .getByRole('button', { name: 'Grid' }),
  ).toHaveAttribute('aria-pressed', 'true');
  // A card opens the page's details.
  await cardFor(page, `${token}03`).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/ops/pages\\?handle=${token}03$`));
  await page.goBack();
  await expect(cardFor(page, `${token}03`)).toBeVisible();
  await page
    .getByRole('group', { name: 'View' })
    .getByRole('button', { name: 'List' })
    .click();
  await expect(rowFor(page, `${token}00`)).toBeVisible();
});

test('filters, search and Clear filters, all kept in the address', async ({
  page,
}, testInfo) => {
  const token = `pf${randomUUID().slice(0, 6)}`;
  await seedAccounts(token, 4, { pro: [0], offline: [3] });
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/users?q=${token}`);
  await expect(rowFor(page, `${token}03`)).toBeVisible();

  await page.getByLabel('Plan').selectOption({ label: 'Pro' });
  await expect(page).toHaveURL(/plan=pro/);
  await expect(rowFor(page, `${token}00`)).toBeVisible();
  await expect(rowFor(page, `${token}01`)).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Remove filter Plan: Pro' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Remove filter Plan: Pro' }).click();
  await expect(page).not.toHaveURL(/plan=pro/);
  await page
    .getByLabel('Page', { exact: true })
    .selectOption({ label: 'Offline' });
  await expect(page).toHaveURL(/pageStatus=offline/);
  await expect(rowFor(page, `${token}03`)).toBeVisible();
  await expect(rowFor(page, `${token}00`)).toHaveCount(0);
  await expect(
    rowFor(page, `${token}03`).getByText('Offline', { exact: true }),
  ).toBeVisible();

  // Nothing matches: says so, and Clear filters clears the search too.
  await page.getByLabel('Plan').selectOption({ label: 'Pro' });
  await expect(
    results(page).getByRole('heading', { name: 'No accounts match.' }),
  ).toBeVisible();
  await results(page).getByRole('button', { name: 'Clear filters' }).click();
  await expect(page).toHaveURL(/\/ops\/users$/);
  await expect(page.getByLabel('Search', { exact: true })).toHaveValue('');

  // Back returns to the filtered view, from the address alone.
  await page.goBack();
  await expect(page).toHaveURL(/plan=pro/);
  await expect(page.getByLabel('Search', { exact: true })).toHaveValue(token);
  await expect(
    results(page).getByRole('heading', { name: 'No accounts match.' }),
  ).toBeVisible();

  // A name finds its account; the row opens the page's details.
  await page.goto(`/ops/users?q=${encodeURIComponent(`Person ${token}02`)}`);
  await expect(rowFor(page, `${token}02`)).toBeVisible();
  await rowFor(page, `${token}02`).getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/ops/pages\\?handle=${token}02$`));
});

test('keyboard: the view switch, a row and the pager all work from the keys', async ({
  page,
}, testInfo) => {
  const token = `pk${randomUUID().slice(0, 6)}`;
  await seedAccounts(token, 27);
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/users?q=${token}`);
  await expect(rowFor(page, `${token}00`)).toBeVisible();

  const grid = page
    .getByRole('group', { name: 'View' })
    .getByRole('button', { name: 'Grid' });
  await grid.focus();
  await page.keyboard.press('Enter');
  await expect(grid).toHaveAttribute('aria-pressed', 'true');
  await expect(cardFor(page, `${token}00`)).toBeVisible();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Space');
  await expect(rowFor(page, `${token}00`)).toBeVisible();

  const next = pager(page).getByRole('link', { name: 'Next ›' });
  await next.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/page=2/);
  await expect(rowFor(page, `${token}26`)).toBeVisible();

  const link = rowFor(page, `${token}26`).getByRole('link');
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/ops/pages\\?handle=${token}26$`));
});

test('the full email needs a reason; couldn’t load offers Try again', async ({
  page,
}, testInfo) => {
  const token = `pr${randomUUID().slice(0, 6)}`;
  await seedAccounts(token, 1);
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/users?q=${token}`);
  const row = rowFor(page, `${token}00`);
  await expect(
    row.getByText(`${token.slice(0, 1)}•••@example.com`),
  ).toBeVisible();
  await row.getByRole('button', { name: /^Reveal .*email$/ }).click();
  await page
    .getByLabel(`Why do you need Person ${token}00’s full email?`)
    .fill(REASON);
  await page.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(row.getByText(`${token}0@example.com`)).toBeVisible();
  const [audit] = await sql<{ reason: string }>(
    `SELECT reason FROM audit_events WHERE action = 'people.email_revealed'
      AND subject_id = (SELECT id::text FROM users WHERE email = $1)`,
    [`${token}0@example.com`],
  );
  expect(audit?.reason).toBe(REASON);

  let fail = true;
  await page.route(/\/v1\/ops\/users\?/, (route) =>
    fail
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'INTERNAL', message: 'x' } },
        })
      : route.continue(),
  );
  await page.goto(`/ops/users?q=${token}&sort=oldest`);
  await expect(
    page.getByRole('alert').filter({ hasText: 'We couldn’t load the list' }),
  ).toBeVisible();
  fail = false;
  await results(page).getByRole('button', { name: 'Try again' }).click();
  await expect(rowFor(page, `${token}00`)).toBeVisible();
});

test('phone: stacked rows, two-column grid, filters in a sheet, no sideways scroll at 320 @mobile', async ({
  page,
}, testInfo) => {
  const token = `pm${randomUUID().slice(0, 6)}`;
  await seedAccounts(token, 3, { pro: [1] });
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/users?q=${token}`);
  const stacked = results(page)
    .getByRole('listitem')
    .filter({ hasText: `@${token}00` });
  await expect(stacked).toBeVisible();
  await expect(results(page).getByRole('table')).toHaveCount(0);
  await expect(pager(page).getByText('Page 1 of 1')).toBeVisible();
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Filters', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await sheet
    .getByRole('group', { name: 'Plan' })
    .getByRole('button', { name: 'Pro' })
    .click();
  await expect(page).toHaveURL(/plan=pro/);
  await expect(sheet.getByRole('button', { name: /^Show \d/ })).toBeVisible();
  await expectAccessible(page);
  await sheet.getByRole('button', { name: /^Show / }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByRole('button', { name: 'Filters · 1' })).toBeFocused();
  await expect(
    results(page)
      .getByRole('listitem')
      .filter({ hasText: `@${token}01` }),
  ).toBeVisible();
  await expect(
    results(page)
      .getByRole('listitem')
      .filter({ hasText: `@${token}00` }),
  ).toHaveCount(0);

  await page.goto(`/ops/users?q=${token}`);
  await page
    .getByRole('group', { name: 'View' })
    .getByRole('button', { name: 'Grid' })
    .click();
  const first = cardFor(page, `${token}00`);
  const second = cardFor(page, `${token}01`);
  await expect(first).toBeVisible();
  const [a, b] = [await first.boundingBox(), await second.boundingBox()];
  expect(Math.round(a!.y)).toBe(Math.round(b!.y));
  expect(b!.x).toBeGreaterThan(a!.x);

  for (const width of [360, 320]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(first).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  }
  await page
    .getByRole('group', { name: 'View' })
    .getByRole('button', { name: 'List' })
    .click();
  await expect(stacked).toBeVisible();
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <=
        document.documentElement.clientWidth,
    ),
  ).toBe(true);
});
