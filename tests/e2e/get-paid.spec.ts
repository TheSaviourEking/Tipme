import { expect, test, type Page } from '@playwright/test';
import { chooseBank } from './bank-fixtures';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';

const hintOf = (email: string) => {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

/** The newest bank-account code email to this address, once it has arrived. */
async function bankCode(page: Page, email: string, seen: number) {
  const inbox = await page.context().newPage();
  try {
    let found = '';
    await expect(async () => {
      await inbox.goto('/dev/inbox');
      await expect(inbox.getByRole('article').first()).toBeVisible();
      const mails = await inbox
        .getByRole('article')
        .filter({ hasText: hintOf(email) })
        .filter({ hasText: 'Confirm your TipMe bank account' })
        .allTextContents();
      expect(mails.length).toBeGreaterThan(seen);
      found = /\b(\d{6})\b/.exec(mails[0] ?? '')?.[1] ?? '';
      expect(found).not.toBe('');
    }).toPass({ timeout: 15_000 });
    return found;
  } finally {
    await inbox.close();
  }
}

test('adding a bank: pick a bank, enter a number, see the name, enter the code, usable', async ({
  page,
}, testInfo) => {
  const { email } = await signUpRecipient(page, testInfo, { live: false });

  // Where Task 7's withdraw and payout failure copy sends people.
  await page.goto('/dashboard/settings#get-paid');
  const card = page.locator('#get-paid');
  await expect(
    card.getByRole('heading', { name: 'Get paid' }),
  ).toBeInViewport();

  // The pretend list has 058, so GTBank's key shows, and no other popular key.
  await card.getByRole('combobox', { name: 'Bank' }).focus();
  const keys = card.getByRole('group', { name: 'Popular' }).getByRole('option');
  await expect(keys).toHaveCount(1);
  await expect(keys).toHaveAccessibleName('GTBank');
  await chooseBank(card, 'guaranty', 'Pretend Guaranty Bank');
  await card.getByLabel('Account number').fill('0123456789');

  const name = card.getByLabel('Name on the account');
  await expect(name).toHaveValue('PRETEND ACCOUNT HOLDER');
  await expect(name).toHaveAttribute('readonly', '');
  await expectAccessible(page);

  await card.getByRole('button', { name: 'Email me a code' }).click();
  const code = card.getByLabel('6-digit code');
  await expect(code).toBeVisible();

  await code.fill('000000');
  await card.getByRole('button', { name: 'Save bank account' }).click();
  await expect(card.getByText('That code isn’t right')).toBeVisible();

  await code.fill(await bankCode(page, email, 0));
  await card.getByRole('button', { name: 'Save bank account' }).click();

  await expect(card.getByText('Usable')).toBeVisible();
  await expect(card.getByText(/Pretend .* ••6789/)).toBeVisible();
  await expect(card).not.toContainText('0123456789');
  expect(await fitsViewport(page)).toBe(true);

  await page.reload();
  await expect(card.getByText('Usable')).toBeVisible();
  await expect(card.getByText(/Pretend .* ••6789/)).toBeVisible();
  await expect(page.locator('body')).not.toContainText(/bachs/i);
  await expectAccessible(page);
});

test('a number the bank does not know: the name is typed instead', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#get-paid');
  const card = page.locator('#get-paid');
  await chooseBank(card, 'guaranty', 'Pretend Guaranty Bank');
  await card.getByLabel('Account number').fill('1234560000');
  const name = card.getByLabel('Name on the account');
  await expect(name).toBeEditable();
  await card.getByRole('button', { name: 'Email me a code' }).click();
  await expect(card.getByText('Enter the name on the account.')).toBeVisible();
});

test('a bank code pasted with a space or a dash still fills all six cells', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#get-paid');
  const card = page.locator('#get-paid');
  await card.getByLabel('Bank').selectOption({ index: 1 });
  await card.getByLabel('Account number').fill('0123456789');
  await card.getByRole('button', { name: 'Check account' }).click();
  await card.getByRole('button', { name: 'Email me a code' }).click();
  const field = card.getByLabel('6-digit code');
  await expect(field).toBeVisible();
  // A real paste: the browser must not cut "123 456" to "123 45" before the space is stripped.
  for (const pasted of ['123 456', '123-456', ' 123456 ']) {
    await page.evaluate(
      (value) => navigator.clipboard.writeText(value),
      pasted,
    );
    await field.fill('');
    await field.focus();
    await page.keyboard.press('ControlOrMeta+V');
    await expect(field).toHaveValue('123456');
    await expect(card.locator('.tm-code-cell')).toHaveText([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
  }
});

test('the code step offers a new code and a way out', async ({
  page,
}, testInfo) => {
  const { email } = await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings#get-paid');
  const card = page.locator('#get-paid');
  await chooseBank(card, 'guaranty', 'Pretend Guaranty Bank');
  await card.getByLabel('Account number').fill('0123456789');
  await card.getByRole('button', { name: 'Email me a code' }).click();
  await expect(card.getByLabel('6-digit code')).toBeVisible();
  await bankCode(page, email, 0);

  await card.getByRole('button', { name: 'Send a new code' }).click();
  await expect(card.getByText('We’ve sent a new code.')).toBeVisible();
  await bankCode(page, email, 1);

  await card.getByRole('button', { name: 'Cancel' }).click();
  await expect(card.getByLabel('6-digit code')).toBeHidden();
  await expect(card.getByLabel('Account number')).toHaveValue('');
});

test('after an email change the card says when, and offers no form', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.route('**/v1/me/payout-destination', (route) =>
    route.fulfill({
      json: {
        data: {
          destination: {
            status: 'usable',
            bankName: 'Pretend Bank',
            last4: '6789',
          },
          bankChangesFrom: '2030-03-04T12:00:00.000Z',
        },
      },
    }),
  );
  await page.goto('/dashboard/settings#get-paid');
  // Sign-up ends on this page, so the goto above only moved to the anchor: load the stub.
  await page.reload();
  const card = page.locator('#get-paid');
  await expect(card.getByText(/until .*2030/)).toBeVisible();
  await expect(card.getByText(/keep going to/)).toBeVisible();
  await expect(card.getByLabel('Account number')).toBeHidden();
  await expect(
    card.getByRole('button', { name: 'Change bank account' }),
  ).toBeHidden();
  // No form, so no bank picker either way.
  await expect(card.getByRole('combobox', { name: 'Bank' })).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'Bank' })).toHaveCount(0);
  await expectAccessible(page);
});

test('a rejected bank account says our payment partner can’t pay to it', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.route('**/v1/me/payout-destination', (route) =>
    route.fulfill({
      json: {
        data: {
          destination: {
            status: 'rejected',
            bankName: 'Pretend Bank',
            last4: '6789',
          },
          bankChangesFrom: null,
        },
      },
    }),
  );
  await page.goto('/dashboard/settings#get-paid');
  await page.reload();
  const card = page.locator('#get-paid');
  await expect(
    card.getByText(
      'Our payment partner can’t pay to this account. Please add another.',
    ),
  ).toBeVisible();
  await expect(card).not.toContainText('payment provider can’t pay');
  await expect(page.locator('body')).not.toContainText(/bachs/i);
});
