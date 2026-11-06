import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import {
  codeFor,
  codeWentStale,
  enrolOwner,
  secondOwner,
  sql,
} from './ops-helpers';

// One admin, truly alone: everyone else's staff row goes, and the global switch really changes.
// So @alone tests are a run of their own, after the others (playwright.config.ts).
test.describe.configure({ mode: 'serial' });

const REASON = 'Checked with the person on a call today';

test.beforeEach(async () => {
  await sql(`UPDATE staff SET revoked_at = now() WHERE revoked_at IS NULL`);
  await sql(
    `UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`,
  );
  await sql(`UPDATE withdrawals_switch SET paused = false`);
});

test('@alone one admin alone does everything at once, sees that they acted alone, and is never told to find someone', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);

  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByLabel('New TipMe fee (%)').fill('7');
  await page
    .locator('form')
    .filter({ has: page.getByLabel('New TipMe fee (%)') })
    .getByLabel('Reason')
    .fill(REASON);
  await page.getByRole('button', { name: 'Set this page’s fee' }).click();
  await expect(page.getByText('Done, without a second person')).toBeVisible();
  await expect(
    page.getByText('Nobody else can approve this', { exact: false }),
  ).toBeVisible();
  await expect(page.getByText('(set by staff for this page)')).toBeVisible();
  await expect(page.getByText('Waiting for a second person')).toHaveCount(0);
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  await page.goto('/ops/approvals');
  await expect(page.getByText('Nothing is waiting')).toBeVisible();
  await expect(page.getByText(/second person/i).first()).toBeVisible();

  await page.goto('/ops');
  const pending = page.getByRole('region', { name: 'Pending approvals' });
  await expect(pending.getByText('Nothing is waiting')).toBeVisible();
  const activity = page.getByRole('region', { name: 'Staff activity' });
  await expect(
    activity.getByText('Acted alone, with nobody else to approve').first(),
  ).toBeVisible();
  await expect(activity.getByText('Change a page’s fee').first()).toBeVisible();
  await expectAccessible(page);
});

test('@alone switching off needs no code and works first time; switching on asks for one', async ({
  page,
}, testInfo) => {
  const owner = await enrolOwner(page, testInfo);
  await page.goto('/ops');
  const control = page.getByTestId('withdrawals-switch');
  await expect(control.getByText('Withdrawals: on.')).toBeVisible();

  await codeWentStale(owner);
  await control
    .getByRole('button', { name: 'Switch off all withdrawals…' })
    .click();
  await control.getByLabel('Why stop all withdrawals?').fill(REASON);
  await control.getByRole('button', { name: 'Switch off' }).click();
  await expect(
    control.getByText('Withdrawals are OFF for everyone'),
  ).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(
    control.getByText('Withdrawals are OFF for everyone'),
  ).toBeVisible();

  await codeWentStale(owner);
  await control
    .getByRole('button', { name: 'Switch withdrawals back on…' })
    .click();
  await control
    .getByLabel(
      'Why is it safe to start again? Queued withdrawals start at once.',
    )
    .fill(REASON);
  await control.getByRole('button', { name: 'Switch on' }).click();
  const prompt = page.getByRole('dialog', { name: 'Enter a fresh code' });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByLabel('Authenticator code')).toBeFocused();
  await expectAccessible(page);

  // Turned down: still off, and it says so.
  await prompt.getByRole('button', { name: 'Not now' }).click();
  await expect(control.getByText(/fresh authenticator code/)).toBeVisible();
  await expect(
    control.getByText('Withdrawals are OFF for everyone'),
  ).toBeVisible();

  await control.getByRole('button', { name: 'Switch on' }).click();
  await prompt.getByLabel('Authenticator code').fill('000000');
  await prompt.getByRole('button', { name: 'Continue' }).click();
  await expect(prompt.getByRole('alert')).toBeVisible();
  await prompt.getByLabel('Authenticator code').fill(await codeFor(owner));
  await prompt.getByRole('button', { name: 'Continue' }).click();
  await expect(control.getByText('Withdrawals: on.')).toBeVisible();
  await page.reload();
  await expect(control.getByText('Withdrawals: on.')).toBeVisible();
});

test('@alone a stale session can freeze and end sessions at once, and releasing asks for a code', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  const owner = await enrolOwner(page, testInfo);
  await page.goto(`/ops/pages?handle=${handle}`);
  await expect(page.getByText('Withdrawals are frozen')).toHaveCount(0);

  await codeWentStale(owner);
  await page.getByRole('button', { name: 'Freeze withdrawals…' }).click();
  await page.getByLabel('Who reported it, and what did they say?').fill(REASON);
  await page.getByRole('button', { name: 'Freeze withdrawals' }).click();
  await expect(page.getByText('Withdrawals are frozen')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('button', { name: 'End all sessions…' }).click();
  await page.getByLabel('Why sign this account out everywhere?').fill(REASON);
  await page.getByRole('button', { name: 'End all sessions' }).click();
  await expect(page.getByText('Signed out everywhere')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.getByRole('link', { name: 'the issue' }).click();
  await page.waitForURL(/\/ops\/issues\//);
  await page.getByRole('button', { name: 'Resolve…' }).click();
  await page.getByLabel('How was it settled?').selectOption('account_secured');
  await page
    .getByLabel(
      'I checked the current bank and the sign-in with the real owner.',
    )
    .check();
  await page.getByLabel('How was it resolved?').fill(REASON);
  await codeWentStale(owner);
  await page.getByRole('button', { name: 'Resolve issue' }).click();
  const prompt = page.getByRole('dialog', { name: 'Enter a fresh code' });
  await prompt.getByLabel('Authenticator code').fill(await codeFor(owner));
  await prompt.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.locator('.ops-issue__status').getByText('Resolved', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('The issue is resolved. Withdrawals are released.'),
  ).toBeVisible();
  await expect(page.getByTestId('action-outcome')).toBeFocused();
});

// Live updates, PR 2 (plan Task 14). @alone: it really switches every withdrawal off. The Withdraw
// page re-reads only on signals (never on the fallback poll), so the change must come from the
// stream: a broadcast, which each tab re-reads after its own random 0-10 s wait.
test('@alone turning withdrawals off shows in an open Withdraw tab within 15 s', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const recipient = await (await browser.newContext()).newPage();
  await signUpRecipient(recipient, testInfo);
  await recipient.goto('/dashboard/withdraw');
  await expect(
    recipient.getByText('Nothing to withdraw right now'),
  ).toBeVisible();
  await expect(recipient.locator('[data-live="connected"]')).toBeAttached({
    timeout: 15_000,
  });
  await recipient.evaluate(() => {
    (window as unknown as { __noReload: number }).__noReload = 1;
  });

  const owner = await enrolOwner(page, testInfo);
  await page.goto('/ops');
  const control = page.getByTestId('withdrawals-switch');
  await control
    .getByRole('button', { name: 'Switch off all withdrawals…' })
    .click();
  await control.getByLabel('Why stop all withdrawals?').fill(REASON);
  await control.getByRole('button', { name: 'Switch off' }).click();
  await expect(
    control.getByText('Withdrawals are OFF for everyone'),
  ).toBeVisible();

  await expect(
    recipient.getByText(
      'Withdrawals are paused for now. Your balance is safe.',
    ),
  ).toBeVisible({ timeout: 15_000 });

  // Back on: TipMe's side no longer stops it, but only a full quote (the partner) can say how
  // much, so the page asks, and asks the partner only when the person taps.
  await control
    .getByRole('button', { name: 'Switch withdrawals back on…' })
    .click();
  await control
    .getByLabel(
      'Why is it safe to start again? Queued withdrawals start at once.',
    )
    .fill(REASON);
  await control.getByRole('button', { name: 'Switch on' }).click();
  const prompt = page.getByRole('dialog', { name: 'Enter a fresh code' });
  if (await prompt.isVisible().catch(() => false)) {
    await prompt.getByLabel('Authenticator code').fill(await codeFor(owner));
    await prompt.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(control.getByText('Withdrawals: on.')).toBeVisible();
  await expect(recipient.getByText('Check what you can withdraw')).toBeVisible({
    timeout: 15_000,
  });
  await expectAccessible(recipient);
  await recipient.getByRole('button', { name: 'Check again' }).click();
  await expect(
    recipient.getByText('Nothing to withdraw right now'),
  ).toBeVisible();
  expect(
    await recipient.evaluate(
      () => (window as unknown as { __noReload?: number }).__noReload,
    ),
  ).toBe(1);
});

// Alone, because every other owner in a parallel run could decide this person's requests too, and
// their requests would show in the count.
test('@alone a request a second owner can decide shows a count of one on their menu, and none on the asker’s', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  const asker = await secondOwner(browser, testInfo);
  const approvals = (on: typeof page) =>
    on
      .getByRole('navigation', { name: 'Admin' })
      .getByRole('link', { name: /^Approvals/ });
  // Nothing waits yet: no count.
  await expect(approvals(page)).toHaveAccessibleName('Approvals');
  await expect(page.locator('.ops-frame__count')).toHaveCount(0);

  await asker.page.goto(`/ops/pages?handle=${handle}`);
  await asker.page.getByLabel('New TipMe fee (%)').fill('7');
  await asker.page
    .locator('form')
    .filter({ has: asker.page.getByLabel('New TipMe fee (%)') })
    .getByLabel('Reason')
    .fill(REASON);
  await asker.page.getByRole('button', { name: 'Set this page’s fee' }).click();
  await expect(
    asker.page.getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible();

  await page.goto('/ops');
  await expect(approvals(page)).toHaveAccessibleName(
    'Approvals (1 waiting for you)',
  );
  await expect(approvals(page).locator('.ops-frame__count')).toHaveText('1');
  await expectAccessible(page);

  await asker.page.goto('/ops');
  await expect(
    asker.page.getByRole('heading', { name: 'Pending approvals' }),
  ).toBeVisible();
  await expect(approvals(asker.page)).toHaveAccessibleName('Approvals');
  await expect(asker.page.locator('.ops-frame__count')).toHaveCount(0);

  // A list that can't be read shows no count, never a wrong one, and the menu still works.
  await page.route('**/v1/ops/approvals?status=pending', (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: 'INTERNAL', message: 'x' } },
    }),
  );
  await page.goto('/ops/staff');
  await expect(approvals(page)).toHaveAccessibleName('Approvals');
  await approvals(page).click();
  await page.waitForURL(/\/ops\/approvals$/);
  await asker.context.close();
});
