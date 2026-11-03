import { expect, test } from '@playwright/test';

// Home, rebuilt to the ScreenHome board (docs/design/redesign/boards/ScreenHome.dc.html).

test('home switches between getting tipped and tipping with one lever', async ({
  page,
}) => {
  await page.goto('/');
  const lever = page.getByRole('radiogroup', { name: 'Show the steps for' });
  const tipped = lever.getByRole('radio', { name: 'If you get tipped' });
  const tipping = lever.getByRole('radio', { name: "If you're tipping" });
  await expect(tipped).toBeChecked();
  const steps = page.locator('main');
  for (const step of ['Make it yours', 'Share it anywhere', 'Get your thanks'])
    await expect(steps.getByText(step, { exact: true })).toBeVisible();
  await expect(steps.getByText('Scan or tap')).toBeHidden();
  await expect(steps.getByText('Say your thanks')).toBeHidden();

  await tipping.click();
  await expect(tipping).toBeChecked();
  for (const step of ['Scan or tap', 'Choose an amount', 'Say your thanks'])
    await expect(steps.getByText(step, { exact: true })).toBeVisible();
  await expect(steps.getByText('Make it yours')).toBeHidden();
  await expect(
    page.getByRole('heading', { name: 'Tip in three steps.' }),
  ).toBeVisible();

  // One tab stop; the arrow keys move the choice with focus.
  await tipping.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tipped).toBeChecked();
  await expect(tipped).toBeFocused();
  await expect(
    page.getByRole('heading', { name: 'Tipped in three steps.' }),
  ).toBeVisible();
});

test('home states the fee and the minimum plainly', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('TipMe keeps 10% of each tip')).toBeVisible();
  await expect(page.getByText('The smallest tip is ₦2,000.')).toBeVisible();
  expect(await page.content()).not.toContain('₦1,000');
});

test('home names global payments, as the owner decided', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.home-lede')).toContainText(
    'global payments (USD, EUR, GBP, NGN, Stablecoins)',
  );
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Let People Celebrate You for the things you do.',
  );
});

test('the hero tip demo uses the standard amounts', async ({ page }) => {
  await page.goto('/');
  // The example card is a picture of a tip page, so it is hidden from assistive technology.
  const demo = page.locator('.home-demo__main');
  for (const amount of ['₦2,000', '₦5,000', '₦10,000'])
    await expect(demo.getByText(amount, { exact: true })).toBeVisible();
  // The people on it are labelled as examples.
  await expect(page.getByText(/examples, not real people/i)).toBeVisible();
});

test('the claim field carries the handle to sign up', async ({ page }) => {
  await page.goto('/');
  const form = page.getByRole('form', { name: 'Claim your link' });
  await form.getByLabel('Your handle').fill('kemi_cuts');
  await form.getByRole('button', { name: 'Claim your username' }).click();
  await expect(page).toHaveURL(/\/sign-up\?handle=kemi_cuts$/);
});
