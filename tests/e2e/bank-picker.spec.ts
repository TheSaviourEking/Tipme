import {
  expect,
  test,
  type Locator,
  type Page,
  type Route,
  type TestInfo,
} from '@playwright/test';
import { chooseBank, standInBanks } from './bank-fixtures';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';

/** A new recipient on the Get paid card, with the stand-in bank list. */
async function openCard(
  page: Page,
  testInfo: TestInfo,
  { standIn = true }: { standIn?: boolean } = {},
) {
  await signUpRecipient(page, testInfo, { live: false });
  if (standIn) await standInBanks(page);
  await page.goto('/dashboard/settings#get-paid');
  // Sign-up ends on this page, so the goto above only moved to the anchor: load the stand-in.
  await page.reload();
  const card = page.locator('#get-paid');
  await expect(card.getByLabel('Account number')).toBeVisible();
  return card;
}

/** Each option's text as a screen reader reads it: the badges are aria-hidden. */
const optionNames = (scope: ReturnType<Page['locator']>) =>
  scope.getByRole('option').evaluateAll((options) =>
    options.map((option) => {
      const copy = option.cloneNode(true) as Element;
      copy
        .querySelectorAll('[aria-hidden="true"]')
        .forEach((el) => el.remove());
      return copy.textContent?.trim() ?? '';
    }),
  );

test('the bank field is a combobox that opens on popular banks, then A to Z', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  const bank = card.getByRole('combobox', { name: 'Bank' });
  await expect(bank).toHaveAttribute('aria-expanded', 'false');
  await bank.focus();
  await expect(bank).toHaveAttribute('aria-expanded', 'true');
  const listbox = page.locator(
    `[id="${await bank.getAttribute('aria-controls')}"]`,
  );
  await expect(listbox).toHaveAttribute('role', 'listbox');
  await expect(listbox).toBeVisible();

  const popular = listbox.getByRole('group', { name: 'Popular' });
  expect(await optionNames(popular)).toEqual([
    'GTBank',
    'Access',
    'Zenith',
    'UBA',
    'First Bank',
    'OPay',
    'Moniepoint',
    'Kuda',
  ]);
  const all = listbox.getByRole('group', { name: 'All banks, A to Z' });
  expect((await optionNames(all)).slice(0, 3)).toEqual([
    'Access Bank',
    'Citibank Nigeria',
    'Ecobank Nigeria',
  ]);
  await expect(
    listbox.getByRole('option', { name: 'LAPO Microfinance Bank' }),
  ).toBeHidden();
  await listbox
    .getByRole('option', { name: 'More banks: microfinance and mortgage' })
    .click();
  await expect(
    listbox.getByRole('option', { name: 'LAPO Microfinance Bank' }),
  ).toBeVisible();
  await expect(bank).toBeFocused();
  await expect(bank).toHaveValue('');
  await expectAccessible(page);
});

test('typing gtb finds Guaranty Trust Bank, and Enter chooses it', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  const bank = card.getByRole('combobox', { name: 'Bank' });
  await bank.fill('gtb');
  const options = card.getByRole('option');
  await expect(options).toHaveCount(1);
  const gt = card.getByRole('option', { name: 'Guaranty Trust Bank' });
  await expect(bank).toHaveAttribute(
    'aria-activedescendant',
    (await gt.getAttribute('id')) ?? '',
  );
  await expect(gt).toHaveAttribute('aria-selected', 'true');
  expect(await gt.locator('mark').allTextContents()).toEqual(['G', 'T', 'B']);
  await expect(
    card.getByRole('status').filter({ hasText: 'match' }),
  ).toHaveText('1 bank matches');
  await bank.press('Enter');
  await expect(bank).toHaveValue('Guaranty Trust Bank');
  await expect(bank).toHaveAttribute('aria-expanded', 'false');
  await expect(card.getByText('Not saved')).toHaveCount(0);
  await expect(card.getByLabel('6-digit code')).toHaveCount(0);
});

test('arrow keys move through the banks and Esc changes nothing', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  const bank = card.getByRole('combobox', { name: 'Bank' });
  await chooseBank(card, 'access', 'Access Bank');
  await bank.press('ArrowDown');
  await expect(bank).toHaveAttribute('aria-expanded', 'true');
  const first = await bank.getAttribute('aria-activedescendant');
  expect(first).toBeTruthy();
  await bank.press('ArrowDown');
  await expect(bank).not.toHaveAttribute('aria-activedescendant', first ?? '');
  const second = await bank.getAttribute('aria-activedescendant');
  await expect(page.locator(`[id="${second}"]`)).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await bank.press('Escape');
  await expect(bank).toHaveAttribute('aria-expanded', 'false');
  await expect(bank).toHaveValue('Access Bank');
});

test('a misspelling says so, and suggests the full name', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  await card.getByRole('combobox', { name: 'Bank' }).fill('gtbnk zz');
  await expect(
    card
      .getByText(
        'No bank matches "gtbnk zz". Check the spelling, or try the bank’s full name.',
      )
      .first(),
  ).toBeVisible();
  await expect(card.getByRole('option')).toHaveCount(0);
});

test('microfinance banks are found by search even while folded away', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  await card.getByRole('combobox', { name: 'Bank' }).fill('lapo');
  await expect(card.getByRole('option').first()).toHaveAccessibleName(
    'LAPO Microfinance Bank',
  );
});

test('forced colours keep the active option and the keys visible', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  await page.emulateMedia({ forcedColors: 'active' });
  const bank = card.getByRole('combobox', { name: 'Bank' });
  await bank.focus();
  await bank.press('ArrowDown');
  const active = page.locator(
    `[id="${await bank.getAttribute('aria-activedescendant')}"]`,
  );
  expect(
    await active.evaluate((el) => getComputedStyle(el).outlineStyle),
  ).not.toBe('none');
  const keys = card.getByRole('group', { name: 'Popular' }).getByRole('option');
  for (const style of await keys.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).borderTopStyle),
  ))
    expect(style).not.toBe('none');
});

test('on a phone, Bank opens a full-screen sheet with the search ready @mobile', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  const trigger = card.getByRole('button', { name: 'Bank' });
  // Nothing chosen yet: the trigger's "Search your bank" is real text and must read clearly.
  await expectAccessible(page);
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: 'Choose your bank' });
  await expect(sheet).toBeVisible();
  expect(await sheet.boundingBox()).toEqual({
    x: 0,
    y: 0,
    width: 360,
    height: 800,
  });
  const search = sheet.getByRole('combobox', { name: 'Search your bank' });
  await expect(search).toBeFocused();
  await search.pressSequentially('fir');
  await expect(sheet.getByRole('option')).toHaveCount(2);
  expect(await optionNames(sheet)).toEqual([
    'First Bank of Nigeria',
    'First City Monument Bank',
  ]);
  await sheet.getByRole('option', { name: 'First Bank of Nigeria' }).click();
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('First Bank of Nigeria');
  await expectAccessible(page);
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await fitsViewport(page)).toBe(true);
  await trigger.click();
  await expect(sheet).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
});

test('the sheet closes with Esc or ✕ and changes nothing @mobile', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  const trigger = card.getByRole('button', { name: 'Bank' });
  const sheet = page.getByRole('dialog', { name: 'Choose your bank' });
  const search = sheet.getByRole('combobox', { name: 'Search your bank' });
  await trigger.click();
  await search.fill('access');
  await sheet.getByRole('option', { name: 'Access Bank' }).click();
  await expect(trigger).toContainText('Access Bank');

  await trigger.click();
  await search.fill('zen');
  await search.press('Escape');
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('Access Bank');

  await trigger.click();
  await search.fill('zen');
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(sheet).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toContainText('Access Bank');
});

test('the sheet does not move when motion is reduced @mobile', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo);
  await card.getByRole('button', { name: 'Bank' }).click();
  const sheet = page.getByRole('dialog', { name: 'Choose your bank' });
  await expect(sheet).toBeVisible();
  expect(await sheet.evaluate((el) => getComputedStyle(el).animationName)).toBe(
    'none',
  );
});

// The name check on its own (board, section C). These use the pretend provider's own list (058
// Pretend Guaranty Bank, 101 Pretend Providus Bank), so the checks reach the real test API.

type Respond = (route: Route, call: number) => Promise<void>;

/** Counts the card's name checks. `respond` answers each one; by default it goes to the API. */
async function watchChecks(page: Page, respond?: Respond) {
  let calls = 0;
  await page.route('**/v1/me/payout-destination/resolve', async (route) => {
    calls += 1;
    if (respond) await respond(route, calls);
    else await route.continue();
  });
  return () => calls;
}

/** A gate a test holds a check at, then opens. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { opened, open };
}

async function chooseByKey(card: Locator, label: string) {
  const bank = card.getByRole('combobox', { name: 'Bank' });
  // A click, as a person would: focus alone does nothing if the field already has it.
  await bank.click();
  await card
    .getByRole('group', { name: 'Popular' })
    .getByRole('option', { name: label })
    .click();
  await expect(bank).toHaveAttribute('aria-expanded', 'false');
}

test('the name is checked once, on the 10th digit, with no button', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo, { standIn: false });
  const held = gate();
  const checks = await watchChecks(page, async (route) => {
    await held.opened;
    await route.continue();
  });
  await chooseByKey(card, 'GTBank');
  const number = card.getByLabel('Account number');
  await number.pressSequentially('012345678');
  await expect(card.getByText('9 of 10')).toBeVisible();
  expect(checks()).toBe(0);
  await expect(card.getByRole('button', { name: 'Check account' })).toHaveCount(
    0,
  );
  await expect(card.getByRole('button', { name: 'Check again' })).toHaveCount(
    0,
  );

  await number.press('9');
  await expect(card.getByText('Checking the name at your bank…')).toBeVisible();
  await expect(number).toBeFocused();
  held.open();
  const name = card.getByLabel('Name on the account');
  await expect(name).toHaveValue('PRETEND ACCOUNT HOLDER');
  await expect(name).toHaveAttribute('readonly', '');
  await expect(card.getByText('9 of 10')).toHaveCount(0);
  expect(checks()).toBe(1);
  await expect(page.locator('body')).not.toContainText(/bachs/i);
});

test('the same bank and number are never checked twice', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo, { standIn: false });
  const checks = await watchChecks(page);
  const name = card.getByLabel('Name on the account');
  await chooseByKey(card, 'GTBank');
  const number = card.getByLabel('Account number');
  await number.fill('0123456789');
  await expect(name).toHaveValue('PRETEND ACCOUNT HOLDER');
  expect(checks()).toBe(1);

  await chooseBank(card, 'providus', 'Pretend Providus Bank');
  await expect(name).toHaveValue('PRETEND ACCOUNT HOLDER');
  expect(checks()).toBe(2);

  await chooseByKey(card, 'GTBank');
  await expect(name).toHaveValue('PRETEND ACCOUNT HOLDER');
  await expect(card.getByText('Checking the name at your bank…')).toHaveCount(
    0,
  );
  // fill, not End then Backspace: on macOS End scrolls the page and leaves the caret at 0.
  await number.fill('012345678');
  await expect(name).toHaveCount(0);
  await number.press('9');
  await expect(number).toHaveValue('0123456789');
  await expect(name).toHaveValue('PRETEND ACCOUNT HOLDER');
  // Give a stray call time to show up before counting.
  await page.waitForTimeout(500);
  expect(checks()).toBe(2);
});

test('no bank chosen: nothing is checked, and it says so', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo, { standIn: false });
  const checks = await watchChecks(page);
  await card.getByLabel('Account number').fill('0123456789');
  await expect(card.getByText('Choose your bank.')).toBeVisible();
  await page.waitForTimeout(500);
  expect(checks()).toBe(0);
  await chooseByKey(card, 'GTBank');
  await expect(card.getByText('Choose your bank.')).toHaveCount(0);
  await expect(card.getByLabel('Name on the account')).toHaveValue(
    'PRETEND ACCOUNT HOLDER',
  );
  expect(checks()).toBe(1);
});

test('a short number says how many digits, and nothing is checked', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo, { standIn: false });
  const checks = await watchChecks(page);
  await chooseByKey(card, 'GTBank');
  const number = card.getByLabel('Account number');
  await number.fill('012345678');
  await number.press('Tab');
  await expect(
    card.getByText('Enter your 10-digit account number.'),
  ).toBeVisible();
  await page.waitForTimeout(500);
  expect(checks()).toBe(0);
  await number.fill('0123456789');
  await expect(
    card.getByText('Enter your 10-digit account number.'),
  ).toHaveCount(0);
});

test('a failed check shows today’s message and Check again, which checks once more', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo, { standIn: false });
  const checks = await watchChecks(page, async (route, call) => {
    if (call === 1)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'PAYOUT_PROVIDER_UNAVAILABLE' } },
      });
    else await route.continue();
  });
  await chooseByKey(card, 'GTBank');
  await card.getByLabel('Account number').fill('0123456789');
  await expect(
    card.getByText(
      'We couldn’t reach our payment partner. Please try again in a moment.',
    ),
  ).toBeVisible();
  const again = card.getByRole('button', { name: 'Check again' });
  await expect(again).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Email me a code' }),
  ).toHaveCount(0);
  await expectAccessible(page);
  expect(checks()).toBe(1);

  await again.click();
  await expect(card.getByLabel('Name on the account')).toHaveValue(
    'PRETEND ACCOUNT HOLDER',
  );
  await expect(again).toBeHidden();
  expect(checks()).toBe(2);
});

test('today’s 10 checks used up: the same message as today', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo, { standIn: false });
  await watchChecks(page, (route) =>
    route.fulfill({ status: 429, json: { error: { code: 'RATE_LIMITED' } } }),
  );
  await chooseByKey(card, 'GTBank');
  await card.getByLabel('Account number').fill('0123456789');
  await expect(
    card.getByText('Too many tries. Please wait a while and try again.'),
  ).toBeVisible();
  await expect(card.getByRole('button', { name: 'Check again' })).toBeVisible();
});

test('a late answer never shows against a newer number', async ({
  page,
}, testInfo) => {
  const card = await openCard(page, testInfo, { standIn: false });
  const held = gate();
  const checks = await watchChecks(page, async (route, call) => {
    if (call === 1) await held.opened;
    await route.continue();
  });
  await chooseByKey(card, 'GTBank');
  const number = card.getByLabel('Account number');
  // The pretend provider finds 1234560001 and not 1234560000.
  await number.fill('1234560001');
  await expect(card.getByText('Checking the name at your bank…')).toBeVisible();
  await number.fill('1234560000');
  const name = card.getByLabel('Name on the account');
  await expect(name).toBeEditable();
  await expect(name).toHaveValue('');
  expect(checks()).toBe(2);

  const late = page.waitForResponse('**/v1/me/payout-destination/resolve');
  held.open();
  await late;
  await page.waitForTimeout(300);
  await expect(name).toBeEditable();
  await expect(name).toHaveValue('');
  await expect(card).not.toContainText('PRETEND ACCOUNT HOLDER');
  await expect(page.locator('body')).not.toContainText(/bachs/i);
});
