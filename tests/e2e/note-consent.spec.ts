import { expect, test, type Page, type Request } from '@playwright/test';
import { expectAccessible } from './helpers';

// A supporter may agree that the recipient shows their note on their page. TipMe never infers the
// recipient's pronoun, so the label says "their page".
const CONSENT = 'Ada may show this note on their page';

async function openDetails(page: Page) {
  await page.goto('/@ada');
  await page.getByRole('radio', { name: '2,000 NGN' }).click();
  await page.getByText('Add a message, reason or your name').click();
}

/** Taps Tip and returns the intent request's body, stopping it before any checkout opens. */
async function intentBody(page: Page) {
  let sent: Request | undefined;
  await page.route('**/v1/tip-intents', async (route) => {
    sent = route.request();
    await route.abort();
  });
  await page.getByRole('button', { name: /^Tip ₦/ }).click();
  await expect.poll(() => sent).toBeTruthy();
  return sent?.postDataJSON() as Record<string, unknown>;
}

test('the consent box appears only with a note, is off by default and is named for the recipient', async ({
  page,
}) => {
  await openDetails(page);
  await expect(page.getByRole('checkbox', { name: CONSENT })).toHaveCount(0);
  await page
    .getByLabel('Personal message (optional)')
    .fill('You made my week.');
  const box = page.getByRole('checkbox', { name: CONSENT });
  await expect(box).toBeVisible();
  await expect(box).not.toBeChecked();
  await expect(
    page.getByText(
      'With your name, if you gave one. Without this, your note stays private.',
    ),
  ).toBeVisible();
});

test('a ticked box is sent; an unticked one is not', async ({ page }) => {
  await openDetails(page);
  await page
    .getByLabel('Personal message (optional)')
    .fill('You made my week.');
  expect(await intentBody(page)).not.toHaveProperty('noteMayShow');

  await openDetails(page);
  await page
    .getByLabel('Personal message (optional)')
    .fill('You made my week.');
  await page.getByRole('checkbox', { name: CONSENT }).check();
  expect(await intentBody(page)).toMatchObject({
    message: 'You made my week.',
    noteMayShow: true,
  });
});

test('clearing the note hides the box and sends no consent', async ({
  page,
}) => {
  await openDetails(page);
  const note = page.getByLabel('Personal message (optional)');
  await note.fill('You made my week.');
  await page.getByRole('checkbox', { name: CONSENT }).check();
  await note.fill('   ');
  await expect(page.getByRole('checkbox', { name: CONSENT })).toHaveCount(0);
  const body = await intentBody(page);
  expect(body).not.toHaveProperty('noteMayShow');
  expect(body).not.toHaveProperty('message');
});

test('the tip form stays accessible with the box shown', async ({ page }) => {
  await openDetails(page);
  await page
    .getByLabel('Personal message (optional)')
    .fill('You made my week.');
  await expect(page.getByRole('checkbox', { name: CONSENT })).toBeVisible();
  await expectAccessible(page);
});
