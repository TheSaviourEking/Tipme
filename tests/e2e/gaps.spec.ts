import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';
import { enrolOwner } from './ops-helpers';
import { API_ORIGIN } from './stack';

// PR-013: reporting a page, profile photos, tip search, notification preferences and admin
// search, as people would use them.
// sharp is the API's dependency (resolved from there); only the part used here is typed.
type MakeImage = (options: {
  create: {
    width: number;
    height: number;
    channels: 3;
    background: { r: number; g: number; b: number };
  };
}) => { jpeg(): { toBuffer(): Promise<Buffer> } };
const sharp = createRequire(resolve('apps/api/package.json'))(
  'sharp',
) as MakeImage;

test('a visitor reports a page and staff find it in the inbox and by search', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/@${handle}`);
  await visitor.getByRole('button', { name: 'Report this page' }).click();
  await visitor
    .getByLabel('What’s wrong with this page?')
    .selectOption('impersonation');
  await expectAccessible(visitor);
  await visitor.getByRole('button', { name: 'Send report' }).click();
  await expect(
    visitor.getByText('Thank you. TipMe will review this page.'),
  ).toBeVisible();

  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.goto('/ops/issues');
  await expect(staff.getByText(`Visitors reported @${handle}`)).toBeVisible();
  await staff.getByRole('link', { name: 'Search' }).click();
  await staff.getByLabel('Search').fill(handle);
  await staff.getByRole('button', { name: 'Search' }).click();
  await expect(staff.getByRole('link', { name: `@${handle}` })).toBeVisible();
  await expectAccessible(staff);
});

test('a recipient adds a photo, searches their tips and turns off tip emails', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  const photo = await sharp({
    create: {
      width: 800,
      height: 600,
      channels: 3,
      background: { r: 122, g: 50, b: 249 },
    },
  })
    .jpeg()
    .toBuffer();
  await page.getByLabel('Choose a photo').setInputFiles({
    name: 'me.jpg',
    mimeType: 'image/jpeg',
    buffer: photo,
  });
  await expect(page.getByText('Photo saved.')).toBeVisible();
  await expect(
    page.getByRole('img', { name: /^Photo of / }).first(),
  ).toBeVisible();

  await page
    .getByLabel('Email me about each tip (when my email is verified)')
    .uncheck();
  await page.getByRole('button', { name: 'Save notifications' }).click();
  await expect(page.getByText('Saved.', { exact: true })).toBeVisible();
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(visitor.getByRole('img', { name: /^Photo of / })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 10_000 });
  // Loaded, not just shown as alt text: the content policy must let images come from the API.
  await expect
    .poll(() =>
      visitor
        .getByRole('img', { name: /^Photo of / })
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(0);

  await tipAsVisitor(browser, handle, { name: 'Bola' });
  await tipAsVisitor(browser, handle, { name: 'Chidi', amount: '5,000 NGN' });
  await page.goto('/dashboard/tips');
  await page.getByLabel('Search').fill('bola');
  await expect(page.getByRole('link', { name: /Tip from Bola/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Tip from Chidi/ })).toHaveCount(
    0,
  );
  await page.getByLabel('Search').fill('5,000');
  await expect(
    page.getByRole('link', { name: /Tip from Chidi/ }),
  ).toBeVisible();
  await page.getByLabel('Search').fill('nobody-here');
  await expect(page.getByText('No tips match “nobody-here”.')).toBeVisible();
  await expectAccessible(page);
});

/** A real paste: the text goes to the clipboard and Ctrl/Cmd+V pastes it into the focused field. */
async function pasteInto(page: Page, field: Locator, text: string) {
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await field.fill('');
  await field.focus();
  await page.keyboard.press('ControlOrMeta+V');
}

// A maxlength of 6 cut a pasted "123 456" to "123 45" before the space was stripped.
test('a code pasted with a space into the recovery email and new email fields keeps all six digits', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { handle } = await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings');
  await page
    .getByLabel('Recovery email address')
    .fill(`r@paste-${handle.replace('_', '-')}.example`);
  await page
    .getByRole('button', { name: 'Send code to recovery email' })
    .click();
  const recovery = page.getByLabel('Code sent to your recovery email');
  await pasteInto(page, recovery, '123 456');
  await expect(recovery).toHaveValue('123456');

  await page
    .getByLabel('New email address')
    .fill(`k@paste-${handle.replace('_', '-')}.example`);
  await page.getByRole('button', { name: 'Send code to new address' }).click();
  const fresh = page.getByLabel('Code sent to the new address');
  await pasteInto(page, fresh, '123 456');
  await expect(fresh).toHaveValue('123456');
});

test('a sign-in code pasted with a space to remove the recovery email keeps all six digits', async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signUpRecipient(page, testInfo, { live: false });
  // A confirmed recovery email, and the code to the sign-in email sent: only the field is real.
  await page.route(`${API_ORIGIN}/v1/me/recovery-email`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          json: { data: { confirmed: true, hint: 'r•••@paste.example' } },
        })
      : route.fallback(),
  );
  await page.route(`${API_ORIGIN}/v1/me/recovery-email/change-code`, (route) =>
    route.fulfill({ json: { data: {} } }),
  );
  await page.goto('/dashboard/settings');
  await page.getByRole('button', { name: 'Remove recovery email' }).click();
  const code = page.getByLabel('Code sent to your sign-in email');
  await pasteInto(page, code, '123 456');
  await expect(code).toHaveValue('123456');
});

/** CORS for an answer the test gives in place of the API. */
const corsFor = (page: Page) => ({
  'access-control-allow-origin': new URL(page.url()).origin,
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
});

test('a report that doesn’t go through says so on its key, and Try again sends it', async ({
  page,
}) => {
  await page.goto('/@ada');
  await page.getByRole('button', { name: 'Report this page' }).click();
  let sent = 0;
  await page.route('**/v1/profiles/*/report', async (route) => {
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: corsFor(page) });
    sent += 1;
    if (sent === 1) return route.abort();
    return route.fulfill({
      status: 201,
      headers: corsFor(page),
      contentType: 'application/json',
      body: JSON.stringify({ data: { accepted: true } }),
    });
  });
  await page.getByRole('button', { name: 'Send report' }).click();
  const key = page.locator('.report-page .tm-key-result--failed');
  await expect(key).toContainText('Not sent');
  await expect(page.locator('.report-page .tm-state-line')).toHaveText(
    'We couldn’t send the report. Please try again.',
  );
  await expect(page.locator('.report-page .tm-state-line')).toHaveAttribute(
    'role',
    'alert',
  );
  await expect(page.locator('.report-page .tm-notice')).toHaveCount(0);
  const again = key.getByRole('button', { name: 'Try again' });
  await expect(again).toBeFocused();
  await expect(again).toHaveAccessibleDescription(/Not sent/);
  await expectAccessible(page);
  await again.click();
  await expect(
    page.getByText('Thank you. TipMe will review this page.'),
  ).toBeVisible();
  expect(sent).toBe(2);
});

test('unsubscribe: a bad link is a slip, and a turn-off that fails is told on its key', async ({
  page,
}) => {
  await page.goto('/email/unsubscribed');
  const slip = page.locator('.tm-slip');
  await expect(slip).toContainText('This link doesn’t work');
  await expect(slip).toContainText('It may have been copied wrongly.');
  await expect(slip).toHaveAttribute('role', 'alert');
  await expect(slip.locator('.tm-slip__stamp')).toHaveCount(0);
  await expectAccessible(page);

  await page.goto('/email/unsubscribed?t=test-token');
  let sent = 0;
  await page.route('**/v1/mail/unsubscribe**', async (route) => {
    if (route.request().method() === 'OPTIONS')
      return route.fulfill({ status: 204, headers: corsFor(page) });
    sent += 1;
    return sent === 1
      ? route.fulfill({
          status: 500,
          headers: corsFor(page),
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'INTERNAL_ERROR' } }),
        })
      : route.fulfill({
          status: 200,
          headers: corsFor(page),
          contentType: 'application/json',
          body: JSON.stringify({ data: { type: 'weekly_report' } }),
        });
  });
  await page.getByRole('button', { name: 'Turn off this email' }).click();
  const key = page.locator('.tm-key-result--failed');
  await expect(key).toContainText('That didn’t go through');
  await expect(page.locator('.tm-state-line')).toHaveText('Please try again.');
  await expect(page.locator('.tm-notice')).toHaveCount(0);
  await expectAccessible(page);
  await key.getByRole('button', { name: 'Try again' }).click();
  await expect(
    page.getByRole('heading', { name: 'You’re unsubscribed.' }),
  ).toBeVisible();
  await expect(page.getByText('weekly report emails')).toBeVisible();
  expect(sent).toBe(2);
});
