import { expect, test } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner, makePagePro } from './ops-helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Free and Pro (PR-012): staff make a page Pro, the recipient chooses their own amounts and
// minimum, and supporters see the exact amount they will pay.

test('staff make a page Pro, the recipient chooses amounts, and supporters see them', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await expect(
    page.getByText(
      /Choosing your own amounts and minimum is part of TipMe Pro/,
    ),
  ).toBeVisible();

  const staff = await (await browser.newContext()).newPage();
  await enrolOwner(staff, testInfo);
  await staff.getByRole('link', { name: 'Pages' }).click();
  await staff.getByLabel('Handle').fill(handle);
  await staff.getByRole('button', { name: 'Find page' }).click();
  await staff.getByRole('button', { name: 'Make Pro…' }).click();
  await staff
    .getByLabel('Why is this page getting Pro?')
    .fill('Pilot recipient for Pro amounts');
  await staff.getByRole('button', { name: 'Make Pro', exact: true }).click();
  await expect(staff.getByText(`@${handle} is now Pro`)).toBeVisible();
  await expectAccessible(staff);

  await page.reload();
  await expect(
    page.getByRole('heading', { name: 'Tip amounts (Pro)' }),
  ).toBeVisible();
  // A preset below the smallest tip: the error is on the amounts, not the minimum.
  await page.getByLabel('Amount 1', { exact: true }).fill('1500');
  await page.getByLabel('Smallest tip (NGN)').fill('2000');
  await page.getByRole('button', { name: 'Save tip amounts' }).click();
  await expect(page.getByLabel('Amount 1', { exact: true })).toHaveAttribute(
    'aria-invalid',
    'true',
  );
  await expect(page.getByText(/each at least your smallest tip/)).toBeVisible();
  await page.getByLabel('Amount 1', { exact: true }).fill('2000');
  await page.getByLabel('Amount 2 (optional)').fill('5,000');
  await page.getByLabel('Amount 3 (optional)').fill('10000');
  await page.getByLabel('Smallest tip (NGN)').fill('2000');
  await page.getByRole('button', { name: 'Save tip amounts' }).click();
  await expect(
    page.getByText('Saved. Your page now shows these amounts.'),
  ).toBeVisible();
  await expectAccessible(page);

  const visitor = await (await browser.newContext()).newPage();
  await expect(async () => {
    await visitor.goto(`/@${handle}`);
    await expect(
      visitor.getByRole('radio', { name: '10,000 NGN' }),
    ).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await expect(visitor.getByRole('radio', { name: '1,000 NGN' })).toHaveCount(
    0,
  );
  await visitor.getByRole('radio', { name: '2,000 NGN' }).click();
  await expect(visitor.getByText('You pay NGN 2,000.00')).toBeVisible();
  await expect(visitor.locator('.tip-breakdown')).toHaveCount(0);
  await visitor.getByLabel(/^Other amount/).fill('1500');
  await visitor.getByRole('button', { name: /^Tip/ }).click();
  await expect(
    visitor.getByText(/Enter an amount of NGN 2,000 or more/),
  ).toBeVisible();
  await expectAccessible(visitor);
});

test('a Free page sees no handle form; Pro changes it with a confirmation, up to the limit, and staff can allow more', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(page, testInfo);
  await page.goto('/dashboard/settings');
  await expect(
    page.getByText('Handle changes are part of TipMe Pro'),
  ).toBeVisible();
  await expect(page.getByLabel('Handle')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change handle' })).toHaveCount(
    0,
  );

  const staff = await makePagePro(browser, handle, testInfo);
  await page.reload();
  await expect(page.getByText('3 changes left')).toBeVisible();

  // Cancelling changes nothing, and focus goes back where it was.
  const first = `${handle}_a`;
  await page.getByLabel('Handle').fill(`@${first.toUpperCase()}`);
  const change = page.getByRole('button', { name: 'Change handle' });
  await change.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(`@${first}`);
  await expect(dialog).toContainText(
    'Old links and printed QR codes keep working',
  );
  await expect(dialog).toContainText('2 changes left');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await expectAccessible(page);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(change).toBeFocused();
  await expect(page.getByText('3 changes left')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Handle')).toHaveValue(handle);

  // Escape cancels too, and the page stays where it was scrolled to.
  await page.getByLabel('Handle').fill(first);
  // Bring the button into view first: with the cards above it the click would scroll the page itself.
  await change.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => scrollY);
  await change.click();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => scrollY)).toBe(scrolled);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(change).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scrolled);
  await expect(page.getByText('3 changes left')).toBeVisible();

  // With reduced motion it opens and closes without moving.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await change.click();
  await expect(dialog).toBeVisible();
  expect(
    await dialog.evaluate((element) => getComputedStyle(element).animationName),
  ).toBe('none');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Confirming changes it.
  await change.click();
  await dialog.getByRole('button', { name: 'Yes, change it' }).click();
  await expect(dialog).toHaveCount(0);
  const host = new URL(page.url()).host;
  await expect(
    page.getByText(`Saved. Your page is now at ${host}/@${first}.`),
  ).toBeFocused();
  await expect(page.getByText('2 changes left')).toBeVisible();

  // The next two, the last one saying so.
  const second = `${handle}_b`;
  await page.getByLabel('Handle').fill(second);
  await change.click();
  await expect(dialog).toContainText('1 change left');
  await dialog.getByRole('button', { name: 'Yes, change it' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('1 change left')).toBeVisible();
  // Switching back to an old handle counts.
  await page.getByLabel('Handle').fill(first);
  await change.click();
  await expect(dialog).toContainText('no changes left');
  await dialog.getByRole('button', { name: 'Yes, change it' }).click();
  await expect(
    page.getByText(`Saved. Your page is now at ${host}/@${first}.`),
  ).toBeVisible();

  // At the limit the form is replaced by how to reach the team.
  await expect(
    page.getByText(
      'You’ve used all your handle changes. Contact the TipMe team to change it again.',
    ),
  ).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Contact the TipMe team' }),
  ).toHaveAttribute('href', 'mailto:support@usetipme.xyz');
  await expect(page.getByLabel('Handle')).toHaveCount(0);
  await expectAccessible(page);

  // Staff allow one more, with a reason.
  await staff.getByLabel('Handle').fill(first);
  await staff.getByRole('button', { name: 'Find page' }).click();
  await expect(staff.getByText('Handle changes: 3 of 3 used')).toBeVisible();
  await staff.getByLabel('More changes to allow').fill('1');
  await staff
    .locator('form', { has: staff.getByLabel('More changes to allow') })
    .getByLabel('Reason')
    .fill('Changed their business name, confirmed by support');
  await staff.getByRole('button', { name: 'Allow more changes' }).click();
  await expect(staff.getByText('Handle changes: 3 of 4 used')).toBeVisible();
  await expectAccessible(staff);
  await page.reload();
  await expect(page.getByText('1 change left')).toBeVisible();
});

test('changing a handle fails honestly: the screen shows what is true, and focus and the dialog are never stuck', async ({
  page,
  browser,
}, testInfo) => {
  test.slow(); // One step waits out the request timeout.
  const { handle } = await signUpRecipient(page, testInfo);
  await makePagePro(browser, handle, testInfo);
  await page.goto('/dashboard/settings');
  const field = page.getByLabel('Handle');
  const change = page.getByRole('button', { name: 'Change handle' });
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Yes, change it' });
  const wanted = `${handle}_x`;
  const handleUrl = `${API_ORIGIN}/v1/me/handle`;
  const profileUrl = `${API_ORIGIN}/v1/me/profile`;
  const refuse = (errorCode: string, status: number) =>
    page.route(handleUrl, (route) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': WEB_ORIGIN,
          'access-control-allow-credentials': 'true',
        },
        body: JSON.stringify({
          error: { code: errorCode, message: 'No', reference: 'test' },
        }),
      }),
    );
  /** Asks for the change and confirms it. */
  const attempt = async () => {
    await field.fill(wanted);
    await change.click();
    await confirm.click();
  };

  // A repeated validation error still moves focus to the field.
  await field.fill('ab');
  await change.click();
  await expect(page.getByText(/Use 3 to 30 letters/)).toBeVisible();
  await expect(field).toBeFocused();
  await change.focus();
  await change.click();
  await expect(field).toBeFocused();

  // Taken at the last moment: the dialog closes, the error is on the field, nothing is counted.
  await refuse('HANDLE_TAKEN', 409);
  await attempt();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('That handle is taken.')).toBeVisible();
  await expect(field).toBeFocused();
  await expect(page.getByText('3 changes left')).toBeVisible();
  await page.unroute(handleUrl);

  // A failed connection that changed nothing: the screen says so and stays as it was.
  await page.route(handleUrl, (route) => route.abort());
  await attempt();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('We couldn’t change that.')).toBeVisible();
  await expect(field).toBeFocused();
  await expect(page.getByText('3 changes left')).toBeVisible();
  await page.unroute(handleUrl);

  // A server error that changed nothing, likewise.
  await refuse('INTERNAL_ERROR', 500);
  await attempt();
  await expect(page.getByText('We couldn’t change that.')).toBeVisible();
  await expect(field).toBeFocused();
  await page.unroute(handleUrl);

  // Neither the change nor the check can be confirmed: it says it can't tell.
  await page.route(handleUrl, (route) => route.abort());
  await page.route(profileUrl, (route) => route.abort());
  await attempt();
  await expect(page.getByText(/couldn’t tell whether/)).toBeVisible();
  await expect(field).toBeFocused();
  await page.unroute(handleUrl);
  await page.unroute(profileUrl);

  // A request that never answers can't hold the person in the dialog.
  await page.route(handleUrl, () => undefined);
  await attempt();
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByText('We couldn’t change that.')).toBeVisible();
  await expect(field).toBeFocused();
  await page.unroute(handleUrl);

  // The change went through but the answer was lost: the screen shows it was saved.
  await page.route(handleUrl, async (route) => {
    await route.fetch();
    await route.abort();
  });
  await attempt();
  await expect(dialog).toHaveCount(0);
  const host = new URL(page.url()).host;
  await expect(
    page.getByText(`Saved. Your page is now at ${host}/@${wanted}.`),
  ).toBeFocused();
  await expect(page.getByText('2 changes left')).toBeVisible();
  await page.unroute(handleUrl);

  // Used up elsewhere: the card swaps, says why, and focus lands on its heading.
  const heading = page.getByRole('heading', { name: 'Your handle' });
  const profileWith = (changes: Record<string, unknown>) =>
    page.route(profileUrl, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, data: { ...body.data, ...changes } },
      });
    });
  await refuse('HANDLE_CHANGE_LIMIT', 409);
  await profileWith({ handleChanges: { used: 3, allowed: 3 } });
  await field.fill(`${handle}_y`);
  await change.click();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({
      hasText: 'You’ve used all your handle changes.',
    }),
  ).toBeVisible();
  await expect(heading).toBeFocused();
  await page.unroute(profileUrl);
  await page.unroute(handleUrl);

  // Pro ended elsewhere, likewise.
  await page.reload();
  await expect(field).toBeVisible();
  await refuse('HANDLE_CHANGE_PRO_REQUIRED', 403);
  await profileWith({ plan: 'free' });
  await field.fill(`${handle}_z`);
  await change.click();
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({
      hasText: 'Handle changes are part of TipMe Pro',
    }),
  ).toBeVisible();
  await expect(heading).toBeFocused();
});
