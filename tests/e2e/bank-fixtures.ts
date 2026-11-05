import { expect, type Locator, type Page } from '@playwright/test';

/** `PayoutBank` from `@tipme/contracts`, which the root test project doesn't depend on. */
export type PayoutBank = { code: string; name: string };

/**
 * A stand-in for the partner's bank list: real-style names, with the popular banks' codes. PalmPay
 * is left out on purpose, so its key must not show.
 */
export const BANKS: PayoutBank[] = [
  { code: '044', name: 'Access Bank' },
  { code: '023', name: 'Citibank Nigeria' },
  { code: '050', name: 'Ecobank Nigeria' },
  { code: '070', name: 'Fidelity Bank' },
  { code: '011', name: 'First Bank of Nigeria' },
  { code: '214', name: 'First City Monument Bank' },
  { code: '058', name: 'Guaranty Trust Bank' },
  { code: '999992', name: 'Paycom (OPay)' },
  { code: '221', name: 'Stanbic IBTC Bank' },
  { code: '033', name: 'United Bank for Africa' },
  { code: '090001', name: 'LAPO Microfinance Bank' },
  { code: '070001', name: 'Abbey Mortgage Bank' },
  { code: '057', name: 'Zenith Bank' },
  { code: '50515', name: 'Moniepoint MFB' },
  { code: '50211', name: 'Kuda Microfinance Bank' },
];

/** Answers the card's bank list with `banks`, as get-paid.spec.ts stubs the destination. */
export async function standInBanks(page: Page, banks: PayoutBank[] = BANKS) {
  await page.route('**/v1/payout-banks', (route) =>
    route.fulfill({ json: { data: banks } }),
  );
}

/** Types `query` into the Bank combobox, moves to the option named `name` and presses Enter on it. */
export async function chooseBank(card: Locator, query: string, name: string) {
  const bank = card.getByRole('combobox', { name: 'Bank' });
  await bank.fill(query);
  const option = card.getByRole('option', { name, exact: true });
  const id = await option.getAttribute('id');
  await expect(async () => {
    if ((await bank.getAttribute('aria-activedescendant')) !== id)
      await bank.press('ArrowDown');
    await expect(bank).toHaveAttribute('aria-activedescendant', id ?? '', {
      timeout: 200,
    });
  }).toPass({ timeout: 5_000 });
  await bank.press('Enter');
  await expect(bank).toHaveValue(name);
}
