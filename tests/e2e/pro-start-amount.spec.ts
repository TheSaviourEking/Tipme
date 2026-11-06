import {
  expect,
  test,
  type Browser,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { makePagePro } from './ops-helpers';

// "Make it yours", PR B: a Pro page chooses which of its own amounts its tip form starts on. Free
// pages, and pages without a choice, start on the amount closest to ₦2,000, as before.

const startsOn = (page: Page) =>
  page.getByRole('group', { name: 'Your page starts on' });
const AUTOMATIC = 'Closest to NGN 2,000 (automatic)';

/** Sign up, have staff make the page Pro, and come back to its tip amounts in Settings. */
async function proPage(page: Page, browser: Browser, testInfo: TestInfo) {
  const { handle } = await signUpRecipient(page, testInfo);
  const staff = await makePagePro(browser, handle, testInfo);
  await page.goto('/dashboard/settings#tip-amounts');
  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Tip amounts (Pro)' }),
  ).toBeVisible();
  return { handle, staff };
}

async function fillAmounts(page: Page, amounts: string[], smallest: string) {
  for (const [index, value] of amounts.entries())
    await page
      .getByLabel(index === 0 ? 'Amount 1' : `Amount ${index + 1} (optional)`, {
        exact: true,
      })
      .fill(value);
  await page.getByLabel('Smallest tip (NGN)').fill(smallest);
}

async function save(page: Page) {
  await page.getByRole('button', { name: 'Save tip amounts' }).click();
  await expect(
    page.getByText('Saved. Your page now shows these amounts.'),
  ).toBeVisible();
}

/** The public page, once its cache has caught up with the save. */
async function expectPageStartsOn(
  browser: Browser,
  handle: string,
  amount: string,
) {
  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(
      visitor.getByRole('radio', { name: `${amount} NGN`, exact: true }),
    ).toBeChecked({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await expect(
    visitor.getByRole('button', { name: `Tip ₦${amount}` }),
  ).toBeVisible();
  return visitor;
}

test('a Pro page picks ₦10,000 to start on, and its page opens on ₦10,000', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const { handle, staff } = await proPage(page, browser, testInfo);
  await staff.close();
  await fillAmounts(page, ['5000', '10,000', '20000'], '5000');
  const group = startsOn(page);
  // The choices follow the amounts as they are typed, and start on automatic.
  await expect(group.getByRole('radio')).toHaveCount(4);
  await expect(group.getByRole('radio', { name: AUTOMATIC })).toBeChecked();
  await group.getByRole('radio', { name: 'NGN 10,000', exact: true }).check();
  await expect(group.locator('label', { hasText: 'NGN 10,000' })).toContainText(
    'Starts here',
  );
  await expect(group.getByText('Starts here')).toHaveCount(1);
  await save(page);
  // The Settings preview starts where the page does.
  const preview = page.getByRole('complementary', {
    name: 'Live preview of your page',
  });
  await expect(preview.locator('.settings-preview__go')).toHaveText(
    'Tip ₦10,000',
  );
  await page.reload();
  await expect(
    startsOn(page).getByRole('radio', { name: 'NGN 10,000', exact: true }),
  ).toBeChecked();
  await expectAccessible(page);

  const visitor = await expectPageStartsOn(browser, handle, '10,000');
  await expectAccessible(visitor);
});

test('removing the chosen amount moves the choice to automatic, and the page starts on the closest to ₦2,000', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const { handle, staff } = await proPage(page, browser, testInfo);
  await staff.close();
  await fillAmounts(page, ['5000', '10000', '20000'], '5000');
  await startsOn(page)
    .getByRole('radio', { name: 'NGN 20,000', exact: true })
    .check();
  await save(page);
  await expectPageStartsOn(browser, handle, '20,000');

  // Clearing the chosen amount takes its choice away; typing it back does not bring it back.
  await page.getByLabel('Amount 3 (optional)').fill('');
  await expect(startsOn(page).getByRole('radio')).toHaveCount(3);
  await expect(
    startsOn(page).getByRole('radio', { name: AUTOMATIC }),
  ).toBeChecked();
  await page.getByLabel('Amount 3 (optional)').fill('20000');
  await expect(
    startsOn(page).getByRole('radio', { name: AUTOMATIC }),
  ).toBeChecked();
  await page.getByLabel('Amount 3 (optional)').fill('');
  await save(page);
  await expectPageStartsOn(browser, handle, '5,000');
  await expectAccessible(page);
});

test('a page that leaves Pro starts on ₦2,000 again, and gets its choice back on Pro', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const { handle, staff } = await proPage(page, browser, testInfo);
  await fillAmounts(page, ['5000', '10000', '20000'], '5000');
  await startsOn(page)
    .getByRole('radio', { name: 'NGN 10,000', exact: true })
    .check();
  await save(page);
  await expectPageStartsOn(browser, handle, '10,000');

  const changePlan = async (open: string, field: string, submit: string) => {
    await staff.getByRole('button', { name: open }).click();
    await staff.getByLabel(field).fill('Pilot check for the starting amount');
    await staff.getByRole('button', { name: submit, exact: true }).click();
  };
  await changePlan(
    'Move back to Free…',
    'Why is this page going back to Free?',
    'Move to Free',
  );
  await expect(staff.getByRole('button', { name: 'Make Pro…' })).toBeVisible();
  // Free: the standard amounts, starting on ₦2,000.
  await expectPageStartsOn(browser, handle, '2,000');
  await page.reload();
  await expect(startsOn(page)).toHaveCount(0);

  await changePlan('Make Pro…', 'Why is this page getting Pro?', 'Make Pro');
  await expect(staff.getByText(`@${handle} is now Pro`)).toBeVisible();
  const visitor = await expectPageStartsOn(browser, handle, '10,000');
  await expectAccessible(visitor);
  await page.reload();
  await expect(
    startsOn(page).getByRole('radio', { name: 'NGN 10,000', exact: true }),
  ).toBeChecked();
  await expectAccessible(page);
});

test('Free sees that choosing the start is part of Pro, with no price', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings#tip-amounts');
  const card = page.locator('#tip-amounts');
  await expect(
    card.getByText('Pro pages choose which amount the page starts on.'),
  ).toBeVisible();
  await expect(startsOn(page)).toHaveCount(0);
  await expect(card.getByRole('radio')).toHaveCount(0);
  // The card names the page's amounts, never what Pro costs.
  await expect(card).not.toContainText(/month|a year|per /i);
  await expectAccessible(page);
});
