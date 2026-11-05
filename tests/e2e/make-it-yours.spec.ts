import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { makePagePro, sql } from './ops-helpers';

// Settings > "Make it yours": the thank-you line on the supporter's receipt, and what else a page
// already makes its own.

const LINE = 'Thank you for backing my channel.';
const chapter = (page: Page) => page.locator('section#yours');
const thanksCard = (page: Page) =>
  chapter(page).locator('.settings-section', {
    has: page.getByRole('heading', { name: 'Your thank-you' }),
  });
const receiptPreview = (page: Page) =>
  page.getByRole('complementary', { name: 'The supporter’s receipt' });

test('Make it yours: a Free page writes its thank-you line and sees it in the receipt preview', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings#yours');
  await expect(
    chapter(page).getByRole('heading', { level: 2, name: 'Make it yours' }),
  ).toBeVisible();
  const field = page.getByLabel('Your thank-you line');
  await field.fill(LINE);
  // The preview follows the edit before anything is saved.
  await expect(receiptPreview(page).getByRole('figure')).toHaveText(LINE);
  await expect(receiptPreview(page)).toContainText('got your thanks.');
  await expect(
    page.getByText(`${Array.from(LINE).length} of 140`),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Save thank-you' }).click();
  await expect(thanksCard(page).getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(page.getByLabel('Your thank-you line')).toHaveValue(LINE);
  await expectAccessible(page);
});

test('Make it yours: a Free page sees card styles and the signature as Pro, with no price', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings#yours');
  const card = thanksCard(page);
  await expect(card.getByRole('radio', { name: 'Night' })).toHaveCount(0);
  await expect(card.getByRole('checkbox')).toHaveCount(0);
  await expect(
    card.getByText('Card styles and your signature are part of TipMe Pro.'),
  ).toBeVisible();
  await expect(card.getByRole('link', { name: /Plan/ })).toHaveAttribute(
    'href',
    '#plan',
  );
  await expect(card).not.toContainText('₦');
  await expect(card).not.toContainText('NGN');
});

test('Make it yours: a Pro page picks Night and signs; the preview shows both', async ({
  page,
  browser,
}, testInfo) => {
  // Sign-up, staff making the page Pro and the save: more than the default time on a busy machine.
  test.slow();
  const { handle } = await signUpRecipient(page, testInfo);
  await page.getByLabel('Display name').fill('Ada Okafor');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
  await (await makePagePro(browser, handle, testInfo)).close();
  // Already on Settings, so going to #yours alone would not load the page's new plan.
  await page.goto('/dashboard/settings#yours');
  await page.reload();
  await page.getByLabel('Your thank-you line').fill(LINE);
  const styles = page.getByRole('group', { name: 'Card style' });
  await expect(styles.getByRole('radio', { name: 'Paper' })).toBeChecked();
  await styles.getByRole('radio', { name: 'Night' }).check();
  await page.getByRole('checkbox', { name: 'Sign it “Ada”' }).check();
  const slip = receiptPreview(page).getByRole('figure');
  await expect(slip).toHaveAttribute('data-style', 'night');
  await expect(slip.locator('figcaption')).toHaveText('Ada');
  await page.getByRole('button', { name: 'Save thank-you' }).click();
  await expect(thanksCard(page).getByRole('status')).toHaveText('Saved');
  await page.reload();
  await expect(
    page
      .getByRole('group', { name: 'Card style' })
      .getByRole('radio', { name: 'Night' }),
  ).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Sign it “Ada”' }),
  ).toBeChecked();
  await expectAccessible(page);
});

test('Make it yours: a link in the line is refused next to the field', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings#yours');
  const field = page.getByLabel('Your thank-you line');
  await field.fill('Find me at www.ada.ng');
  await page.getByRole('button', { name: 'Save thank-you' }).click();
  const error = thanksCard(page).getByText(
    'Keep it to 140 characters, with no links.',
  );
  await expect(error).toBeVisible();
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  const errorId = await error.getAttribute('id');
  expect(await field.getAttribute('aria-describedby')).toContain(errorId);
  await expect(field).toBeFocused();
  await expect(thanksCard(page).getByRole('status')).toHaveText('');
});

test('Make it yours: the "already yours" card links to the cover, QR and tip amounts', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings#yours');
  const card = chapter(page).locator('.settings-section', {
    has: page.getByRole('heading', {
      name: 'Covers that move, QR codes that are yours',
    }),
  });
  await expect(card).toContainText(
    'Free has three animated covers that play once',
  );
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(card).not.toContainText('₦');

  await card.getByRole('link', { name: /cover/i }).click();
  await expect(page).toHaveURL(/#cover$/);
  await expect(page.locator('#cover')).toBeInViewport();

  await page.goto('/dashboard/settings#yours');
  await card.getByRole('link', { name: /tip amounts/i }).click();
  await expect(page).toHaveURL(/#tip-amounts$/);
  await expect(page.locator('#tip-amounts')).toBeInViewport();

  await page.goto('/dashboard/settings#yours');
  await card.getByRole('link', { name: /QR/ }).click();
  await expect(page).toHaveURL(/\/dashboard\/qr$/);
  await expectAccessible(page);
});

test('Make it yours: the counter counts what is saved, after spaces collapse', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings#yours');
  await page.getByLabel('Your thank-you line').fill('  Thank   you  ');
  await expect(page.getByText('9 of 140')).toBeVisible();
  // The preview is named once, by its visible label.
  const preview = receiptPreview(page);
  await expect(preview).toHaveAttribute('aria-labelledby', /.+/);
  await expect(preview).not.toHaveAttribute('aria-label', /.*/);
});

test('Make it yours: a page that loses Pro while Settings is open falls back to Free and can still save its line', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const { handle } = await signUpRecipient(page, testInfo);
  await (await makePagePro(browser, handle, testInfo)).close();
  await page.reload();
  await page.goto('/dashboard/settings#yours');
  await page.getByLabel('Your thank-you line').fill(LINE);
  await page
    .getByRole('group', { name: 'Card style' })
    .getByRole('radio', { name: 'Night' })
    .check();
  // Staff move the page to Free while Settings is still open.
  await sql(`UPDATE profiles SET plan = 'free' WHERE handle_lower = $1`, [
    handle,
  ]);
  await page.getByRole('button', { name: 'Save thank-you' }).click();
  const card = thanksCard(page);
  await expect(
    card.getByText('Card styles and your signature are part of TipMe Pro.', {
      exact: false,
    }),
  ).toHaveCount(2);
  // The card shows Free now, and the message is the card's, not the line field's.
  await expect(card.getByRole('group', { name: 'Card style' })).toHaveCount(0);
  await expect(page.getByLabel('Your thank-you line')).toHaveAttribute(
    'aria-invalid',
    'false',
  );
  await page.getByRole('button', { name: 'Save thank-you' }).click();
  await expect(card.getByRole('status')).toHaveText('Saved');
  await expectAccessible(page);
});
