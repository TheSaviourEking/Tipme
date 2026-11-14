import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { codeFor, enrolOwner, secondOwner } from './ops-helpers';

// Paid Pro, plan Task 3 (board OpsProPrice): an owner asks for a new Pro price with a reason, a
// second person approves it in Approvals, and the history lists it. Pretend money only.
const REASON = 'Launch offer agreed with the owner today';

const naira = (kobo: number) => `₦${(kobo / 100).toLocaleString('en-NG')}`;
const kobo = (text: string) => Number(text.replace(/[^0-9]/g, '')) * 100;

const fitsWidth = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

// @alone: approving changes the live price for every page, and other specs (pro-buy, pro) expect the
// launch price, so nothing may run beside it or after it on the same database.
test('@alone an owner asks to change the Pro price, a second person approves, and history lists it', async ({
  page,
  browser,
}, testInfo) => {
  // Two approval rounds (the change, then putting it back) on a shared, loaded machine.
  test.setTimeout(120_000);
  await enrolOwner(page, testInfo);
  const second = await secondOwner(browser, testInfo);
  await page.goto('/ops/pro-price');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { name: 'Prices', level: 1 }),
  ).toBeVisible();
  const live = main.getByTestId('pro-price-live');
  await expect(live).toHaveText(/₦[\d,]+ a month/);
  const before = kobo((await live.textContent()) ?? '');
  const wanted = before + 50_000;

  await main.getByRole('button', { name: '₦500 more' }).click();
  await expect(main.getByTestId('pro-price-new')).toHaveText(naira(wanted));
  await main.getByLabel('Reason for this change').fill(REASON);
  await expectAccessible(page);
  await main.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Waiting for a second person', { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  // Nothing changed yet.
  await expect(live).toHaveText(`${naira(before)} a month`);

  await second.page.goto('/ops/approvals');
  const card = second.page
    .getByRole('article')
    .filter({ hasText: `to ${naira(wanted)} a month` });
  await card.getByRole('button', { name: 'Approve…' }).click();
  await card.getByLabel('Authenticator code').fill(await codeFor(second));
  await card.getByRole('button', { name: 'Approve and run' }).click();
  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(live).toHaveText(`${naira(wanted)} a month`);
  const history = main.getByRole('list', { name: 'History' });
  await expect(
    history
      .getByRole('listitem')
      .first()
      .getByText(`${naira(wanted)} a month`),
  ).toBeVisible();
  await expect(history.getByRole('listitem').first()).toContainText(
    'approved by',
  );
  await expectAccessible(page);

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(
    main.getByRole('heading', { name: 'Prices', level: 1 }),
  ).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);

  // Put the price back the same way, so a rerun on this lane starts where it did.
  await page.setViewportSize({ width: 1280, height: 720 });
  await main.getByRole('button', { name: '₦500 less' }).click();
  await expect(main.getByTestId('pro-price-new')).toHaveText(naira(before));
  await main.getByLabel('Reason for this change').fill(`${REASON} (put back)`);
  await main.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Waiting for a second person', { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await second.page.goto('/ops/approvals');
  const back = second.page
    .getByRole('article')
    .filter({ hasText: `to ${naira(before)} a month` });
  await back.getByRole('button', { name: 'Approve…' }).click();
  await back.getByLabel('Authenticator code').fill(await codeFor(second));
  await back.getByRole('button', { name: 'Approve and run' }).click();
  await expect(back).toHaveCount(0);
  await second.context.close();
  await page.reload();
  await expect(live).toHaveText(`${naira(before)} a month`);
});
