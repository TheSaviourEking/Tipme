import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { chooseBank, standInBanks } from './bank-fixtures';
import { expectAccessible, signUpRecipient } from './helpers';

/** A new recipient on the Get paid card, with the stand-in bank list. */
async function openCard(page: Page, testInfo: TestInfo) {
  await signUpRecipient(page, testInfo, { live: false });
  await standInBanks(page);
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
