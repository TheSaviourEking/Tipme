import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';
import { makePagePro } from './ops-helpers';
import { API_ORIGIN } from './stack';

/** Runs the weekly-report job for this week, as the worker would on a Monday. */
async function runWeeklyReport(
  page: Page,
  request: APIRequestContext,
  handle: string,
) {
  const run = await request.post(`${API_ORIGIN}/v1/dev/jobs/weekly-report`, {
    data: {
      handle,
      isoWeek: await page.evaluate(() => {
        const now = new Date(Date.now() + 3600_000);
        const day = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const weekday = day.getUTCDay() || 7;
        day.setUTCDate(day.getUTCDate() + 4 - weekday);
        const week = Math.ceil(
          ((day.getTime() - Date.UTC(day.getUTCFullYear(), 0, 1)) / 86400000 +
            1) /
            7,
        );
        return `${day.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
      }),
    },
  });
  expect(run.ok()).toBe(true);
}

test('a recipient reads their week and shares it without supporters’ names', async ({
  page,
  browser,
  request,
}, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'share', {
      value: undefined,
      configurable: true,
    });
  });
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, {
    name: 'Zed Q.',
    message: 'Thank you!',
  });
  await runWeeklyReport(page, request, handle);
  await page.goto('/dashboard');
  await page.getByRole('link', { name: /Your week/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Your week',
  );
  await expect(page.getByText('₦1,860').first()).toBeVisible();
  await expect(page.getByText('Most frequent supporter: Zed Q.')).toBeVisible();
  await expect(page.getByText('Only you can see this')).toBeVisible();
  await expectAccessible(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Share my week' }).click();
  expect((await download).suggestedFilename()).toMatch(
    /^tipme-week-\d{4}-W\d{2}\.png$/,
  );
  await page.setViewportSize({ width: 320, height: 720 });
  expect(await fitsViewport(page)).toBe(true);
});

test('each tip reads like a message, with what you received and what was given', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Bola' });
  await page.goto('/dashboard/tips');
  const row = page.getByRole('link', { name: /Tip from Bola/ });
  await expect(row).toContainText('₦1,860');
  await expect(row).toContainText('from ₦2,000');
  // Search, filters and the CSV export stay, out of the way.
  await expect(page.getByLabel('Search')).toBeVisible();
  await expect(page.getByRole('button', { name: 'With a note' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Download as CSV' }),
  ).toBeVisible();
  await expectAccessible(page);
});

test('the tip detail is a receipt: tipped, TipMe’s 7% on Free, received', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, {
    name: 'Bola',
    message: 'Your notes helped me pass.',
  });
  await tipAsVisitor(browser, handle, {
    name: 'Rude R.',
    message: 'Buy followers cheap',
  });
  await page.goto('/dashboard/tips');
  await page.getByRole('link', { name: /Tip from Bola/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '₦1,860 from Bola',
  );
  const receipt = page.locator('.receipt');
  await expect(receipt.getByText('Bola tipped')).toBeVisible();
  await expect(receipt).toContainText('₦2,000');
  await expect(
    receipt.getByText('TipMe fee (7%, includes processing)'),
  ).toBeVisible();
  await expect(receipt).toContainText('−₦140');
  // The policy the tip was priced under, recorded on it (owner, 12 Nov 2026).
  await expect(receipt).toContainText('v2-free-7pct');
  await expect(receipt.getByText('You received')).toBeVisible();
  await expect(receipt.getByText('In your balance')).toBeVisible();
  await expect(receipt.getByText(/…[0-9a-f-]{6}/)).toBeVisible();
  await expect(page.getByText(/payment provider|paystack/i)).toHaveCount(0);
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Hide this note' }).click();
  await expect(page.getByText('You hid this note.')).toBeVisible();
  await expect(page.getByText('Your notes helped me pass.')).toHaveCount(0);

  await page.goto('/dashboard/tips');
  await page.getByRole('link', { name: /Tip from Rude R\./ }).click();
  await page.getByRole('button', { name: 'Report this note' }).click();
  await page.getByLabel('What’s wrong with it?').selectOption('spam');
  await page.getByRole('button', { name: 'Send report' }).click();
  await expect(
    page.getByText(
      'You reported this note. It is hidden, and TipMe is reviewing it.',
    ),
  ).toBeVisible();
});

// The owner's pricing, 12 Nov 2026: a Pro page's tips are priced at 5%, and the receipt says so.
test('on Pro the receipt shows TipMe’s 5%, recorded on the tip', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const { handle } = await signUpRecipient(page, testInfo);
  await makePagePro(browser, handle, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Bola' });
  await page.goto('/dashboard/tips');
  await page.getByRole('link', { name: /Tip from Bola/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    '₦1,900 from Bola',
  );
  const receipt = page.locator('.receipt');
  await expect(
    receipt.getByText('TipMe fee (5%, includes processing)'),
  ).toBeVisible();
  await expect(receipt).toContainText('−₦100');
  await expect(receipt).toContainText('v2-pro-5pct');
});

test('the week’s notes are a stack you press through', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada', message: 'First note.' });
  await tipAsVisitor(browser, handle, { name: 'Bo', message: 'Second note.' });
  await runWeeklyReport(page, request, handle);
  await page.goto('/dashboard');
  // The notes are found by asking for tips with a note, not by paging through every tip.
  const asked = page.waitForRequest(/\/v1\/me\/tips\?.*note=with/);
  await page.getByRole('link', { name: /Your week/ }).click();
  await asked;
  const next = page.getByRole('button', { name: 'Next note' });
  const current = page.getByTestId('note-text');
  await expect(next).toBeVisible();
  const first = await current.innerText();
  expect(['“First note.”', '“Second note.”']).toContain(first);
  // The new note is announced: the visible note sits in a polite live region.
  await expect(page.locator('.week-stack [aria-live="polite"]')).toContainText(
    first,
  );
  await next.click();
  await expect(current).not.toHaveText(first);
  const second = await current.innerText();
  await next.click();
  await expect(current).toHaveText(first);
  expect(second).not.toBe(first);
  await expectAccessible(page);
});

test(
  'on a phone a tip row and the receipt clear the tab bar @mobile',
  { tag: '@mobile' },
  async ({ page, browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile', 'Phone width only.');
    const { handle } = await signUpRecipient(page, testInfo);
    await tipAsVisitor(browser, handle, {
      name: 'Bola',
      message: 'Thank you.',
    });
    await page.goto('/dashboard/tips');
    const row = page.getByRole('link', { name: /Tip from Bola/ });
    await expect(row).toBeVisible();
    expect(await fitsViewport(page)).toBe(true);
    await row.click();
    const receipt = page.locator('.receipt');
    await expect(receipt).toBeVisible();
    expect(await fitsViewport(page)).toBe(true);
    const bar = page.getByRole('navigation', { name: 'Dashboard' });
    await page
      .getByRole('button', { name: 'Report this note' })
      .scrollIntoViewIfNeeded();
    const barBox = await bar.boundingBox();
    const last = await page
      .getByRole('button', { name: 'Report this note' })
      .boundingBox();
    expect(last!.y + last!.height).toBeLessThanOrEqual(barBox!.y);
  },
);

test('a note that cannot be read leaves the rest of the stack', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada', message: 'First note.' });
  await tipAsVisitor(browser, handle, { name: 'Bo', message: 'Second note.' });
  await runWeeklyReport(page, request, handle);
  // One tip's detail fails at the network; the other still reads.
  let failed = false;
  await page.route(/\/v1\/me\/tips\/[0-9a-f-]{36}$/, async (route) => {
    if (!failed) {
      failed = true;
      await route.abort();
    } else await route.continue();
  });
  await page.goto('/dashboard');
  await page.getByRole('link', { name: /Your week/ }).click();
  await expect(page.getByTestId('note-text')).toBeVisible();
  await expect(page.getByText('1 of 1')).toBeVisible();
});

test('home on a desktop: the side column is at least 18rem and the week’s figure is set in the editorial face', async ({
  page,
  browser,
  request,
}, testInfo) => {
  // D1 (ScreenAudit: "Right column thin").
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada' });
  await runWeeklyReport(page, request, handle);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard');
  const side = page.locator('.dashboard-home__side');
  const figure = side.locator('.week-teaser__figure');
  await expect(figure).toHaveText(/^₦[\d,]+$/);
  expect((await side.boundingBox())!.width).toBeGreaterThanOrEqual(288);
  expect(
    await figure.evaluate((element) => getComputedStyle(element).fontFamily),
  ).toMatch(/dm ?serif/i);
  await expect(page.getByRole('link', { name: /Your week/ })).toBeVisible();
  await expectAccessible(page);
});
