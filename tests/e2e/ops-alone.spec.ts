import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { codeFor, codeWentStale, enrolOwner, sql } from './ops-helpers';

// One admin, truly alone: everyone else's staff row goes, and the global switch really changes.
// So this has its own project, run after the others (playwright.config.ts).
test.describe.configure({ mode: 'serial' });

const REASON = 'Checked with the person on a call today';

test.beforeEach(async () => {
  await sql(`UPDATE staff SET revoked_at = now() WHERE revoked_at IS NULL`);
  await sql(
    `UPDATE approval_requests SET status = 'cancelled' WHERE status = 'pending'`,
  );
  await sql(`UPDATE withdrawals_switch SET paused = false`);
});

test('one admin alone does everything at once, sees that they acted alone, and is never told to find someone', async ({
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
  await page.getByLabel('Reason').first().fill(REASON);
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

test('switching off needs no code and works first time; switching on asks for one', async ({
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

test('a stale session can freeze and end sessions at once, and releasing asks for a code', async ({
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
});
