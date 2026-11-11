import { expect, test } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';

test('the tips header says what was received and from how many tips', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await tipAsVisitor(browser, handle, { name: 'Bo' });
  await page.goto('/dashboard/tips');
  // Two ₦2,000 tips, each ₦1,800 to the recipient: the API's total, formatted and nothing more.
  await expect(page.getByText('₦3,600 from 2 tips so far')).toBeVisible();
});

test('a tip still being confirmed is not in the totals', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/tip-totals', (route) =>
    route.fulfill({
      json: {
        data: { currency: 'NGN', receivedNetMinor: '0', paidTipCount: 0 },
      },
    }),
  );
  await page.goto('/dashboard/tips');
  await expect(page.getByRole('heading', { name: 'Your tips' })).toBeVisible();
  await expect(page.getByText(/so far/)).toHaveCount(0);

  // A paid tip makes the real totals. A tip still being confirmed then appears in the list (a real
  // one settles within seconds, so the list is faked): the header comes from the API alone, so it
  // does not move. Integration tests cover the SQL excluding confirming tips.
  await page.unroute('**/v1/me/tip-totals');
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await page.route('**/v1/me/tips?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        data: {
          ...body.data,
          items: [
            {
              tipId: '11111111-1111-4111-8111-111111111111',
              at: new Date().toISOString(),
              supporterLabel: 'Slow Sam',
              hasMessage: false,
              grossMinor: '5000000',
              netMinor: '4500000',
              state: 'confirming',
            },
            ...body.data.items,
          ],
        },
      },
    });
  });
  await page.reload();
  await expect(page.getByText('Slow Sam')).toBeVisible();
  await expect(page.getByText('₦1,800 from 1 tip so far')).toBeVisible();
});

test('With a note lists only tips with a note', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.', message: 'Thank you' });
  await tipAsVisitor(browser, handle, { name: 'Bo' });
  await page.goto('/dashboard/tips');
  const filters = page.getByRole('group', { name: 'Show' });
  await expect(filters.getByRole('button')).toHaveText([
    'All',
    'With a note',
    'Being confirmed',
  ]);
  await expect(page.getByRole('link', { name: /Tip from/ })).toHaveCount(2);
  await filters.getByRole('button', { name: 'With a note' }).click();
  const rows = page.getByRole('link', { name: /Tip from/ });
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText('Ada M.');
  await expect(rows).toContainText('with a note');
  await expectAccessible(page);
});

test('the totals keep showing when a refresh fails', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await page.goto('/dashboard/tips');
  const subtitle = page.getByText('₦1,800 from 1 tip so far');
  await expect(subtitle).toBeVisible();
  await page.route('**/v1/me/tip-totals', (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'x' } },
    }),
  );
  // Choosing a filter reads the totals again; the answer fails and the last figures stay.
  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes('/v1/me/tip-totals') && response.status() === 503,
  );
  await page
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: 'With a note' })
    .click();
  await refreshed;
  await expect(subtitle).toBeVisible();
});

const editorial = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((element) => getComputedStyle(element).fontFamily);

test('tips: each amount is set in the editorial face, and a desktop shows the totals beside the list', async ({
  page,
  browser,
}, testInfo) => {
  // D1 (ScreenAudit: "Rows are thin and grey; the money has no weight", "Desktop right side empty").
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, { name: 'Ada M.' });
  await tipAsVisitor(browser, handle, { name: 'Bo' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard/tips');
  await expect(page.getByText('₦3,600 from 2 tips so far')).toBeVisible();
  expect(
    await editorial(page.locator('.tip-row__money strong').first()),
  ).toMatch(/dm ?serif/i);
  expect(await editorial(page.locator('.tips-total strong'))).toMatch(
    /dm ?serif/i,
  );
  await expect(page.locator('.tips-total strong')).toHaveText(/^₦[\d,]+$/);
  const aside = (await page.locator('.tips-aside').boundingBox())!;
  const day = (await page.locator('.tips-day').first().boundingBox())!;
  expect(aside.x).toBeGreaterThanOrEqual(day.x + day.width);
  // One paper card per day: the rows sit between hairlines inside it, not as separate cards.
  expect(
    await page
      .locator('.tips-list')
      .first()
      .evaluate((list) => getComputedStyle(list).borderTopStyle),
  ).toBe('solid');
  // A phone keeps today's order: the header, the controls, then the list.
  await page.setViewportSize({ width: 390, height: 844 });
  const asidePhone = (await page.locator('.tips-aside').boundingBox())!;
  const dayPhone = (await page.locator('.tips-day').first().boundingBox())!;
  expect(asidePhone.y + asidePhone.height).toBeLessThanOrEqual(dayPhone.y);
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
});

test('a tip being confirmed carries its state as a stamp in the list', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.route('**/v1/me/tips?*', (route) =>
    route.fulfill({
      json: {
        data: {
          items: [
            {
              tipId: '11111111-1111-4111-8111-111111111111',
              at: new Date().toISOString(),
              supporterLabel: 'Slow Sam',
              hasMessage: false,
              grossMinor: '200000',
              netMinor: '180000',
              state: 'confirming',
            },
          ],
          nextCursor: null,
        },
      },
    }),
  );
  await page.goto('/dashboard/tips');
  const row = page.getByRole('link', { name: /Tip from Slow Sam/ });
  await expect(row.locator('.tm-stamp')).toHaveText('Being confirmed');
  // The word is the stamp's, not a grey line after the time.
  await expect(row.locator('.tip-row__who small')).not.toContainText('·');
});

test('tip detail on a desktop: the receipt and its note side by side; without a note the receipt is centred', async ({
  page,
  browser,
}, testInfo) => {
  // D1 (ScreenAudit: "Receipt card small and left, half the desktop empty").
  const { handle } = await signUpRecipient(page, testInfo);
  await tipAsVisitor(browser, handle, {
    name: 'Bola',
    message: 'Your notes helped me pass.',
  });
  await tipAsVisitor(browser, handle, { name: 'Quiet Q.' });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/dashboard/tips');
  await page.getByRole('link', { name: /Tip from Bola/ }).click();
  const receipt = page.locator('.receipt');
  const note = page.locator('.tip-detail__note');
  await expect(note.getByText('Your notes helped me pass.')).toBeVisible();
  const receiptBox = (await receipt.boundingBox())!;
  const noteBox = (await note.boundingBox())!;
  expect(receiptBox.x + receiptBox.width).toBeLessThanOrEqual(noteBox.x);
  expect(noteBox.y).toBeLessThan(receiptBox.y + receiptBox.height);
  expect(await editorial(page.getByRole('heading', { level: 1 }))).toMatch(
    /dm ?serif/i,
  );
  // The note's controls sit with the note.
  await expect(
    note.getByRole('button', { name: 'Hide this note' }),
  ).toBeVisible();
  await expectAccessible(page);

  await page.goto('/dashboard/tips');
  await page.getByRole('link', { name: /Tip from Quiet Q\./ }).click();
  await expect(receipt).toBeVisible();
  await expect(note).toHaveCount(0);
  const alone = (await receipt.boundingBox())!;
  const width = await page.evaluate(() => document.documentElement.clientWidth);
  const main = (await page.locator('.tip-detail').boundingBox())!;
  // Centred in the content column, within a few pixels.
  expect(
    Math.abs(
      alone.x - main.x - (main.x + main.width - (alone.x + alone.width)),
    ),
  ).toBeLessThanOrEqual(4);
  expect(alone.width).toBeLessThanOrEqual(width);
});
