import { expect, test, type Locator, type Page } from '@playwright/test';
import { signUpRecipient, tipAsVisitor } from './helpers';
import { sql } from './ops-helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';

// Dashboard layout from the UI audit (15 Nov 2026): the measurements behind each fix, so a later
// rule can't quietly bring the fault back. `main` clips overflow-x, so a box wider than the screen
// never shows as page scroll: these compare boxes with the layout viewport instead.

test.setTimeout(120_000);

/** The layout viewport's width (never innerWidth: Linux Chromium's scrollbar gutter, e2e AGENTS). */
const viewportWidth = (page: Page) =>
  page.evaluate(() => document.documentElement.clientWidth);

async function rightEdge(box: Locator) {
  const rect = (await box.boundingBox())!;
  return rect.x + rect.width;
}

const style = (box: Locator, property: string) =>
  box.evaluate(
    (el, name) => getComputedStyle(el).getPropertyValue(name),
    property,
  );

test('a tip with a note: the receipt and the note stand side by side at full width', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, {
    name: 'Tolu',
    message: 'Thank you for the wonderful braids last weekend!',
  });
  const [tip] = await sql<{ id: string }>(
    `SELECT t.id FROM tips t JOIN profiles p ON p.id = t.profile_id
       JOIN tip_messages m ON m.tip_id = t.id WHERE p.handle_lower = $1`,
    [handle],
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/dashboard/tips/${tip!.id}`);
  const main = page.getByRole('main');
  const note = main.locator('.tip-detail__note');
  await expect(note).toContainText('wonderful braids', {
    timeout: 15_000,
  });
  // The old 40rem cap left the note about 40px wide, one letter per line.
  expect((await note.boundingBox())!.width).toBeGreaterThan(320);
  const receipt = (await main.locator('.receipt').boundingBox())!;
  const noteBox = (await note.boundingBox())!;
  expect(noteBox.x).toBeGreaterThan(receipt.x + receipt.width);
  // The header leaves the dashboard's own action alone: no "Go to my dashboard" here.
  await expect(
    page
      .getByRole('navigation', { name: 'Main navigation' })
      .getByRole('link', { name: 'Go to my dashboard' }),
  ).toHaveCount(0);
});

test('campaigns at 320px: the list stays inside the screen, each campaign one stacked row', async ({
  page,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await sql(`UPDATE profiles SET plan = 'pro' WHERE handle_lower = $1`, [
    handle,
  ]);
  await page.goto('/dashboard/campaigns/new');
  const main = page.getByRole('main');
  await main.getByLabel('Name').fill('Lagos Live weekend');
  await main
    .getByLabel('Link')
    .fill(`c${testInfo.workerIndex}${Date.now().toString(36)}`);
  await main.getByRole('button', { name: 'Create campaign' }).click();
  await page.waitForURL(/\/dashboard\/campaigns\/[0-9a-f-]{36}$/);

  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto('/dashboard/campaigns');
  const table = main.getByRole('table');
  await expect(
    table.getByRole('rowheader', { name: /Lagos Live weekend/ }),
  ).toBeVisible({ timeout: 15_000 });
  const width = await viewportWidth(page);
  expect(await rightEdge(main.locator('.campaigns-card'))).toBeLessThanOrEqual(
    width,
  );
  // The counts are on screen, not clipped off the right: Received is the last of them.
  const received = table.locator('td[data-label="Received"]').first();
  await expect(received).toBeVisible();
  expect(await rightEdge(received)).toBeLessThanOrEqual(width);
  // Still a table for screen readers: its column headings are there, only hidden from sight.
  await expect(table.getByRole('columnheader', { name: 'Visits' })).toHaveCount(
    1,
  );
});

test('Work and Business: section titles below the page title, one black primary key', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({
    owner: userId,
    name: 'Kemi’s Kitchen',
  });
  await seedMember({
    locationId: business.locations[0]!.id,
    profileId,
    shownName: 'Kemi',
  });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard/work');
  const main = page.getByRole('main');
  const h1 = main.getByRole('heading', { level: 1, name: 'Work' });
  const place = main.getByRole('heading', { level: 2, name: /Kemi’s Kitchen/ });
  await expect(place).toBeVisible({ timeout: 15_000 });
  const h1Size = parseFloat(await style(h1, 'font-size'));
  // The global h2 (up to 60px) was larger than the page's own title.
  expect(parseFloat(await style(place, 'font-size'))).toBeLessThan(h1Size);
  expect(
    parseFloat(
      await style(
        main.getByRole('heading', { level: 3, name: 'On shift' }),
        'font-size',
      ),
    ),
  ).toBeLessThanOrEqual(20);
  // Saving or continuing is black in the dashboard, inside a card or not (theme rollout slice 3).
  await expect(main.getByRole('button', { name: 'Save' })).toHaveCSS(
    'background-color',
    'rgb(0, 0, 0)',
  );

  await page.goto('/dashboard/business');
  const details = main.getByRole('heading', { level: 2, name: 'Details' });
  await expect(details).toBeVisible({ timeout: 15_000 });
  expect(parseFloat(await style(details, 'font-size'))).toBeLessThan(
    parseFloat(
      await style(main.getByRole('heading', { level: 1 }), 'font-size'),
    ),
  );
});

test('Earnings: the switches are the dashboard segmented control, the bars neutral but the latest', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await sql(`UPDATE profiles SET plan = 'pro' WHERE handle_lower = $1`, [
    handle,
  ]);
  await tipAsVisitor(browser, handle);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard/earnings');
  const main = page.getByRole('main');
  const weeks = main.getByRole('button', { name: '12 weeks' });
  await expect(weeks).toHaveAttribute('aria-pressed', 'true', {
    timeout: 15_000,
  });
  await expect(main.locator('.earnings-trend .filter-row')).toHaveCount(1);
  const fills = main.locator('.earnings-trend .bar-chart__fill');
  await expect(fills).toHaveCount(12);
  const purple = 'rgb(122, 50, 249)';
  await expect(fills.last()).toHaveCSS('background-color', purple);
  expect(await style(fills.first(), 'background-color')).not.toBe(purple);
});
