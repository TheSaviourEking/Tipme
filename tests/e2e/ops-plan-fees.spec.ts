import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { enrolOwner, secondOwner } from './ops-helpers';

// The owner, 18 Nov 2026: TipMe's fee per plan is an admin setting (Free 5%, Pro 3% to start). A
// change is a money change: a second person decides it. Nothing is approved here, so the rates every
// other spec expects never move: the second person rejects, and nothing changes.
const REASON = 'Trying a lower Free fee for the test';

const fitsWidth = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

// @alone: it asks for a change to the rates every page uses, so nothing may run beside it.
test('@alone an owner asks to change the plan fees; it waits for a second person, who can reject it', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  await enrolOwner(page, testInfo);
  const second = await secondOwner(browser, testInfo);
  await page.goto('/ops/plan-fees');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { name: 'Fees', level: 1 }),
  ).toBeVisible();
  const live = main.getByTestId('plan-fees-live');
  await expect(live).toHaveText('Free 5% · Pro 3% of each tip');
  await expect(
    main.getByRole('heading', { name: 'Personal: Free / Pro' }),
  ).toBeVisible();
  await expect(
    main.getByRole('heading', { name: 'Business: tips / Business Pro' }),
  ).toBeVisible();
  await expect(main.getByTestId('business-payout-fee')).toContainText(
    'the business pays the transfer fee from the amount',
  );
  await expectAccessible(page);

  // Pro above Free is refused on the screen, before anything is asked.
  await main.getByLabel('Free plan fee (%)').fill('3');
  await main.getByLabel('Pro plan fee (%)').fill('4');
  await main.getByLabel('Reason for this change').fill(REASON);
  await main.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Pro’s fee can’t be higher than Free’s.'),
  ).toBeVisible();

  // Each fee is from 1.5% to 10% (owner, 18 Nov 2026), refused on the screen.
  await main.getByLabel('Free plan fee (%)').fill('12');
  await main.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Each fee must be from 1.5% to 10%.'),
  ).toBeVisible();

  // A move of more than 2 percentage points needs the box ticked before anything is asked.
  await main.getByLabel('Free plan fee (%)').fill('8');
  await main.getByLabel('Pro plan fee (%)').fill('3');
  await main.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Tick the box to confirm the big change.'),
  ).toBeVisible();
  await expect(main.getByLabel(/I confirm this big change/)).not.toBeChecked();

  await main.getByLabel('Free plan fee (%)').fill('4.5');
  await main.getByLabel('Pro plan fee (%)').fill('3');
  await main.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Waiting for a second person', { exact: true }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await expect(live).toHaveText('Free 5% · Pro 3% of each tip');

  await second.page.goto('/ops/approvals');
  const card = second.page.getByRole('article').filter({
    hasText:
      'Change TipMe’s fee from Free 5% and Pro 3% to Free 4.5% and Pro 3%, for new tips only',
  });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Reject…' }).click();
  await card.getByLabel('Why reject it?').fill('Not agreed with the owner yet');
  await card.getByRole('button', { name: 'Reject request' }).click();
  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(live).toHaveText('Free 5% · Pro 3% of each tip');
  await expect(
    main.getByText('Waiting for a second person', { exact: true }),
  ).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 720 });
  await expect(
    main.getByRole('heading', { name: 'Fees', level: 1 }),
  ).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
