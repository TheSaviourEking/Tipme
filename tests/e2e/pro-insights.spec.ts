import { expect, test, type Page } from '@playwright/test';
import { tipFromProfile } from '../shared/tip-flow';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';
import { enrolOwner, sql } from './ops-helpers';

// Pro insights (ProEarnings and ProCampaigns boards; owner default rulings 2, 7, 10). Pretend
// payments only. Pages are checked at 390px and 1440px, and with axe.

const widths = [390, 1440] as const;
const fitsWidth = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

async function recipient(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
  plan: 'pro' | 'free',
) {
  const { handle } = await signUpRecipient(page, testInfo);
  await sql(
    `UPDATE profiles SET display_name = 'Ada Okafor', plan = $2 WHERE handle_lower = $1`,
    [handle, plan],
  );
  return handle;
}

test('earnings: Pro sees the chart, period tiles and notes; Free sees the basics and an example preview', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo, 'pro');
  await tipAsVisitor(browser, handle);
  await page.goto('/dashboard/earnings');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { name: 'Earnings', level: 1 }),
  ).toBeVisible();
  const totals = main.getByRole('region', { name: 'Your totals' });
  await expect(totals.getByText('This week')).toBeVisible();
  await expect(totals.getByText('This year')).toBeVisible();
  await expect(totals.getByText('₦1,860').first()).toBeVisible();
  await expect(
    main.getByRole('heading', { name: 'Week by week' }),
  ).toBeVisible();
  // The chart's values are in a table: screen readers always, anyone with "Show as a table".
  await main.getByRole('button', { name: 'Show as a table' }).first().click();
  await expect(
    main.getByRole('table', { name: /each week, the last 12 weeks/ }),
  ).toBeVisible();
  await expect(main.getByText('Average tip')).toBeVisible();
  await expect(main.getByText('Best day of the week')).toBeVisible();
  await expect(
    main.getByText('Notes show once there are at least 10 tips in the period.'),
  ).toBeVisible();
  await expect(main.getByText('Example')).toHaveCount(0);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(page);
  }

  // The same page on Free: the basics, then one example preview (never their own numbers).
  await sql(`UPDATE profiles SET plan = 'free' WHERE handle_lower = $1`, [
    handle,
  ]);
  await page.goto('/dashboard/earnings');
  await expect(totals.getByText('All time')).toBeVisible();
  await expect(main.getByText('Example')).toBeVisible();
  await expect(
    main.getByRole('heading', { name: 'See how your appreciation grows' }),
  ).toBeVisible();
  await expect(
    main.getByRole('link', { name: 'See TipMe Pro' }),
  ).toHaveAttribute('href', '/pro');
  await expect(main.getByRole('heading', { name: 'Week by week' })).toHaveCount(
    0,
  );
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(page);
  }
});

test('Campaign Studio: make a campaign, a visitor tips through its link, and the tip counts to it', async ({
  page,
  browser,
}, testInfo) => {
  const handle = await recipient(page, testInfo, 'free');
  await page.goto('/dashboard/campaigns');
  const main = page.getByRole('main');
  await expect(main.getByText('0 of 1 used.', { exact: false })).toBeVisible();
  await expectAccessible(page);
  await main.getByRole('link', { name: 'New campaign' }).click();
  await page.waitForURL(/\/dashboard\/campaigns\/new$/);
  await main.getByLabel('Name').fill('Saturday gig');
  await expect(main.getByLabel('Link')).toHaveValue('saturday-gig');
  await expectAccessible(page);
  await main.getByRole('button', { name: 'Create campaign' }).click();
  await page.waitForURL(/\/dashboard\/campaigns\/[0-9a-f-]{36}$/);
  await expect(
    main.getByRole('heading', { name: 'Saturday gig', level: 1 }),
  ).toBeVisible();
  await expect(main.getByText(`/@${handle}/saturday-gig`)).toBeVisible();
  await expect(main.getByRole('img', { name: /QR code for/ })).toBeVisible();
  const detailUrl = page.url();

  // The visitor opens the campaign link: the normal page, with no campaign name on it.
  const context = await browser.newContext();
  const visitor = await context.newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}/saturday-gig`);
    await expect(visitor.getByRole('radio', { name: '2,000 NGN' })).toBeVisible(
      {
        timeout: 1000,
      },
    );
  }).toPass({ timeout: 10_000 });
  await expect(visitor.getByText('Saturday gig')).toHaveCount(0);
  expect(await visitor.content()).not.toContain('Saturday gig');
  let sent: Record<string, unknown> | undefined;
  visitor.on('request', (request) => {
    if (
      request.url().endsWith('/v1/tip-intents') &&
      request.method() === 'POST'
    )
      sent = request.postDataJSON() as Record<string, unknown>;
  });
  await tipFromProfile(visitor);
  expect(sent?.campaign).toBe('saturday-gig');
  await context.close();

  // Recorded once, on that campaign; one tip shows "Fewer than 3" with the amount hidden.
  const rows = await sql<{ n: number }>(
    `SELECT count(*)::int AS n FROM tip_campaigns tc JOIN campaigns c ON c.id = tc.campaign_id
      JOIN profiles p ON p.id = c.profile_id WHERE p.handle_lower = $1 AND c.slug = 'saturday-gig'`,
    [handle],
  );
  expect(rows[0]?.n).toBe(1);
  await page.goto(detailUrl);
  const results = main.getByRole('region', { name: 'Results' });
  await expect(results.getByText('Fewer than 3').first()).toBeVisible();
  await expect(results.getByText('Hidden')).toBeVisible();
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(page);
  }
  await page.goto('/dashboard/campaigns');
  const table = main.getByRole('table', { name: 'Last 30 days' });
  const row = table.getByRole('row', { name: /Saturday gig/ });
  // Visits: at least the visitor's open of the link (anonymous events; the retry may add one).
  await expect(row.getByRole('cell').nth(1)).toHaveText(/^[1-9]\d*$/);
  await expect(row.getByText('Fewer than 3')).toBeVisible();
  // Free has 1: the button gives way to the note.
  await expect(main.getByRole('link', { name: 'New campaign' })).toHaveCount(0);
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    expect(await fitsWidth(page)).toBe(true);
    await expectAccessible(page);
  }
});

test('priority support: a Pro request is answered first, and sorts first in the ops queue', async ({
  page,
  browser,
}, testInfo) => {
  // A Free person writes first, then a Pro person.
  const free = await browser.newContext();
  const freePage = await free.newPage();
  await recipient(
    freePage,
    { ...testInfo, workerIndex: testInfo.workerIndex + 50 },
    'free',
  );
  await freePage.goto('/dashboard/help');
  await expect(
    freePage.getByText('Pro requests are answered first.'),
  ).toHaveCount(0);
  await freePage.getByLabel('What do you need help with?').selectOption('tip');
  await freePage
    .getByLabel('Tell us what happened')
    .fill('A tip did not show up');
  await freePage.getByRole('button', { name: 'Send to TipMe support' }).click();
  await expect(
    freePage.getByText('Sent. TipMe support will reply by email.'),
  ).toBeVisible();
  await free.close();

  const pro = await browser.newContext();
  const proPage = await pro.newPage();
  const proHandle = await recipient(
    proPage,
    { ...testInfo, workerIndex: testInfo.workerIndex + 60 },
    'pro',
  );
  await proPage.goto('/dashboard/help');
  const help = proPage.getByRole('main');
  await expect(
    help.getByText('Pro requests are answered first.'),
  ).toBeVisible();
  await help.getByLabel('Tell us what happened').fill('My withdrawal is late');
  await help.getByRole('button', { name: 'Send to TipMe support' }).click();
  await expect(
    help.getByText('Sent. TipMe support will reply by email.'),
  ).toBeVisible();
  await expect(
    help.getByRole('region', { name: 'Your requests' }).getByText('Waiting'),
  ).toBeVisible();
  for (const width of widths) {
    await proPage.setViewportSize({ width, height: 900 });
    expect(await fitsWidth(proPage)).toBe(true);
    await expectAccessible(proPage);
  }
  await pro.close();

  await enrolOwner(page, testInfo);
  await page.goto('/ops/issues');
  const list = page.getByRole('main').getByRole('list').first();
  const first = list.getByRole('listitem').first();
  await expect(first.getByText('Pro · answer first')).toBeVisible();
  await expect(first.getByText(`@${proHandle}`)).toBeVisible();
  // Its words are not in the queue; they need the audited reveal.
  await expect(page.getByText('My withdrawal is late')).toHaveCount(0);
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
});
