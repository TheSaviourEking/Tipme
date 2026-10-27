import { expect, type Page } from '@playwright/test';

/**
 * A supporter tips from a profile page that is already open, through the pretend provider, and
 * lands on the receipt. Shared by the e2e suite and the staging release check, so a change to
 * the tip form's copy breaks the PR's e2e check rather than only the check after deployment.
 */
export async function tipFromProfile(
  page: Page,
  {
    amount = '2,000 NGN',
    name,
    message,
    outcome = /^Pay/,
  }: {
    amount?: string;
    name?: string;
    message?: string;
    outcome?: RegExp;
  } = {},
) {
  await page.getByRole('radio', { name: amount }).check();
  // The tip summary shows only what the supporter pays.
  await expect(page.getByText(/^You pay NGN [\d,]+\.\d\d$/)).toBeVisible();
  if (message)
    await page.getByLabel('Personal message (optional)').fill(message);
  if (name) {
    // The profile keeps the optional extras behind a disclosure.
    await page.getByText('Add your name or remember tips').click();
    await page.getByLabel('Your name (optional)').fill(name);
  }
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  await page.getByRole('button', { name: outcome }).click();
  await page.waitForURL(/\/tip\//);
}
