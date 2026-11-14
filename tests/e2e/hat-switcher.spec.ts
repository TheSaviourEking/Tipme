import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { accountOf, seedBusiness } from './business-fixtures';
import { businessOnlyOwner } from './business-signup-fixtures';
import { expectAccessible, signUpRecipient } from './helpers';

// Business sign-up, Task D6: the account-menu switcher. BUSINESS_SIGNUP_ENABLED is on in the e2e
// stack (playwright.config.ts).

test.slow();

const accountButton = (page: Page) =>
  page.getByRole('main').getByRole('button', { name: /^Account:/ });

test('a page and an owned business: switch to the business from the menu and back', async ({
  page,
}, testInfo) => {
  const me = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(me.email);
  const name = `Suya ${randomUUID().slice(0, 4)}`;
  const business = await seedBusiness({ owner: userId, name });
  await page.goto('/dashboard');
  const button = accountButton(page);
  await expect(button).toHaveAccessibleName('Account: My page', {
    timeout: 20_000,
  });
  await button.click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('group', { name: 'You', exact: true }),
  ).toContainText(`@${me.handle}`);
  await expect(
    menu.getByRole('group', { name: 'Businesses you own' }),
  ).toContainText(name);
  await expect(menu.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await expectAccessible(page);
  await menu.getByRole('menuitem', { name: new RegExp(name) }).click();
  await page.waitForURL(
    new RegExp(`/dashboard/business\\?business=${business.businessId}$`),
  );
  await expect(accountButton(page)).toHaveAccessibleName(`Account: ${name}`);

  await accountButton(page).click();
  await page
    .getByRole('menu')
    .getByRole('menuitem', { name: /My page/ })
    .click();
  await page.waitForURL(/\/dashboard$/);
  await expect(accountButton(page)).toHaveAccessibleName('Account: My page');
});

test('keyboard only: open with Enter, arrows move, Escape closes and returns focus', async ({
  page,
}, testInfo) => {
  const me = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(me.email);
  const name = `Kilishi ${randomUUID().slice(0, 4)}`;
  await seedBusiness({ owner: userId, name, status: 'pending' });
  await page.goto('/dashboard');
  const button = accountButton(page);
  await expect(button).toBeVisible({ timeout: 20_000 });
  await button.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(items.nth(1)).toBeFocused();
  await expect(items.nth(1)).toContainText('Pending');
  await page.keyboard.press('ArrowUp');
  await expect(items.first()).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(button).toBeFocused();
  // Into the business by keyboard.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/dashboard\/business\?business=/);
});

test('a business-only login: the menu offers “Turn on your page”, not a page hat', async ({
  page,
}, testInfo) => {
  await businessOnlyOwner(page, testInfo);
  await page.goto('/dashboard/business');
  const button = accountButton(page);
  await expect(button).toHaveAccessibleName('Account: Mama Put Lekki', {
    timeout: 20_000,
  });
  await button.click();
  const menu = page.getByRole('menu');
  await expect(
    menu.getByRole('menuitem', { name: /Turn on your page/ }),
  ).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: /My page/ })).toHaveCount(0);
  await expectAccessible(page);
});
