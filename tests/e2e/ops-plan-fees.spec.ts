import { expect, test, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import { enrolOwner, secondOwner, sql } from './ops-helpers';
import { signUpRecipient } from './helpers';

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
  // Fee waivers (spec 2026-11-23 §5) retired the business payout fee switch: who pays a business's
  // withdrawal fee is a fee waiver rule now, so this screen no longer shows the switch's line.
  await expect(main.getByTestId('business-payout-fee')).toHaveCount(0);
  await expect(main.getByText('TipMe pays business payout fees')).toHaveCount(
    0,
  );
  // The card cost (owner, 26 Nov 2026), under the plan rates: the defaults, and where card is offered.
  const cards = main.getByRole('region', { name: 'Card costs' });
  await expect(cards.getByTestId('card-costs-live')).toHaveText(
    'Card fee 2% + ₦45, margin ₦15',
  );
  await expect(cards.getByTestId('card-costs-offer')).toHaveText(
    'Card is offered on Free tips from ₦2,000 and Pro tips from ₦6,000',
  );
  // Where card starts at each plan's rate (profit guards, Part 3), in the Personal fees region.
  const personalRates = main.getByRole('region', { name: 'Personal fees' });
  await expect(personalRates.getByTestId('plan-fees-card-free')).toHaveText(
    'Free at 5%: Card is offered on tips from ₦2,000.',
  );
  await expect(personalRates.getByTestId('plan-fees-card-pro')).toHaveText(
    'Pro at 3%: Card is offered on tips from ₦6,000.',
  );
  await expect(
    personalRates.getByText('Below the 2% floor', { exact: false }),
  ).toHaveCount(0);
  // Saving asks for a reason before anything is asked.
  await cards.getByLabel('Margin (₦)').fill('20');
  await cards.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    cards.getByText('Please write a reason of at least 10 characters.'),
  ).toBeVisible();
  await expectAccessible(page);

  // The plan fee form, apart from the card cost one on the same page.
  const personal = main.getByRole('region', { name: 'Personal fees' });

  // Pro above Free is refused on the screen, before anything is asked.
  await personal.getByLabel('Free plan fee (%)').fill('3');
  await personal.getByLabel('Pro plan fee (%)').fill('4');
  await personal.getByLabel('Reason for this change').fill(REASON);
  await personal.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Pro’s fee can’t be higher than Free’s.'),
  ).toBeVisible();

  // Typing a fee says where card would start at it; 2% never offers card.
  await personal.getByLabel('Free plan fee (%)').fill('3');
  await expect(personal.getByTestId('plan-fees-typed-free')).toHaveText(
    'Card is offered on tips from ₦6,000.',
  );
  await personal.getByLabel('Free plan fee (%)').fill('2');
  await expect(personal.getByTestId('plan-fees-typed-free')).toHaveText(
    'Card is not offered at this rate.',
  );
  // Below the 2% floor is refused on the screen (1.5% was allowed before 26 Nov 2026).
  await personal.getByLabel('Free plan fee (%)').fill('1.5');
  await personal.getByLabel('Pro plan fee (%)').fill('1.5');
  await personal.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Each fee must be from 2% to 10%.'),
  ).toBeVisible();

  // Each fee is from 2% to 10% (profit guards, 26 Nov 2026), refused on the screen.
  await personal.getByLabel('Free plan fee (%)').fill('12');
  await personal.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Each fee must be from 2% to 10%.'),
  ).toBeVisible();

  // A move of more than 2 percentage points needs the box ticked before anything is asked.
  await personal.getByLabel('Free plan fee (%)').fill('8');
  await personal.getByLabel('Pro plan fee (%)').fill('3');
  await personal.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    main.getByText('Tick the box to confirm the big change.'),
  ).toBeVisible();
  await expect(
    personal.getByLabel(/I confirm this big change/),
  ).not.toBeChecked();

  await personal.getByLabel('Free plan fee (%)').fill('4.5');
  await personal.getByLabel('Pro plan fee (%)').fill('3');
  await personal.getByRole('button', { name: 'Ask for approval' }).click();
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

// Profit guards, Part 3: a plan rate stored before the 2% floor is flagged. The plan rates table is
// append-only, so a row can't be seeded and removed without touching every other spec's rates; the
// screen is given the API's answer for such a row instead (the API side is in the database
// integration tests: a stored 150 still reads back and prices).
test('@alone a plan rate stored below the 2% floor is flagged on the plan fees screen', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  await enrolOwner(page, testInfo);
  await page.route('**/v1/ops/plan-fees', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    body.data.current.freeBps = 150;
    body.data.current.proBps = 150;
    await route.fulfill({ response, json: body });
  });
  await page.goto('/ops/plan-fees');
  const personal = page
    .getByRole('main')
    .getByRole('region', { name: 'Personal fees' });
  await expect(personal.getByTestId('plan-fees-live')).toHaveText(
    'Free 1.5% · Pro 1.5% of each tip',
  );
  await expect(personal.getByText('Free: Below the 2% floor')).toBeVisible();
  await expect(personal.getByText('Pro: Below the 2% floor')).toBeVisible();
  await expect(personal.getByTestId('plan-fees-card-free')).toHaveText(
    'Free at 1.5%: Card is not offered at this rate.',
  );
});

// A page rate stored before the floor (100 bps), seeded on this test's own page only.
test('@alone a page rate stored below the 2% floor is flagged on page pricing', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  await sql(
    `UPDATE profiles SET custom_fee_bps = 100 WHERE lower(handle) = lower($1)`,
    [handle],
  );
  await page.goto(`/ops/pages?handle=${handle}`);
  const pricing = page
    .getByRole('main')
    .locator('section, div')
    .filter({
      has: page.getByRole('heading', { name: 'Pricing', exact: true }),
    });
  await expect(pricing.getByText('Below the 2% floor').first()).toBeVisible();
  // A new rate under the floor is refused on the screen; nothing is asked.
  await page.getByRole('button', { name: 'Set this page’s fee…' }).click();
  await page.getByLabel('New TipMe fee (%)').fill('1.5');
  await page
    .getByLabel('Reason', { exact: true })
    .fill('Trying below the floor');
  await page.getByRole('button', { name: 'Set this page’s fee' }).click();
  await expect(
    page.getByText(
      'Write the fee as a percentage of 2 or more, or 0 for fee-free.',
    ),
  ).toBeVisible();
});
