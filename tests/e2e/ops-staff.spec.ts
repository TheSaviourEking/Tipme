import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  identity,
  signInWithEmail,
  signUpRecipient,
} from './helpers';
import {
  codeFor,
  codeWentStale,
  emailedEnrolmentCode,
  enrolOwner,
  mismatchedTip,
  secondOwner,
  sql,
  totpNow,
} from './ops-helpers';

// Two or more staff exist here, so serious actions wait. ops-alone.spec.ts covers one person.
const REASON = 'Checked with the person on a call today';

const waiting = (page: Page) =>
  page.getByText('Waiting for a second person', { exact: true });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Admin' });

const feeForm = (page: Page) =>
  page.locator('form').filter({ has: page.getByLabel('New TipMe fee (%)') });

/** Fills the fee form on the Pages screen for this handle; nothing has happened until approved. */
async function askForFee(page: Page, handle: string, percent = '7') {
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByLabel('New TipMe fee (%)').fill(percent);
  await feeForm(page).getByLabel('Reason').fill(REASON);
  await page.getByRole('button', { name: 'Set this page’s fee' }).click();
}

const requestCard = (page: Page, handle: string) =>
  page.getByRole('article').filter({ hasText: `@${handle}` });

test('an owner adds a person; they sign in, enrol, and see only their menu', async ({
  page,
  browser,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const roleName = `Searcher ${randomUUID().slice(0, 6)}`;
  await page.goto('/ops/staff/roles');
  await expect(page.getByRole('heading', { name: 'Roles' })).toBeVisible();
  await page.getByRole('button', { name: 'New role…' }).click();
  await page.getByLabel('Role name').fill(roleName);
  await page.getByRole('checkbox', { name: /^search\.view/ }).check();
  await page.getByLabel('Why this role?').fill(REASON);
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByRole('heading', { name: roleName })).toBeVisible();
  await expectAccessible(page);

  const { email } = identity({ ...testInfo, workerIndex: 7 });
  await page.goto('/ops/staff/people');
  await page.getByRole('button', { name: 'Add a person…' }).click();
  await page.getByLabel('Their email').fill(email);
  await page
    .getByLabel('Role', { exact: true })
    .selectOption({ label: roleName });
  await page.getByLabel('Why are you adding them?').fill(REASON);
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByText('Invitation sent')).toBeVisible();
  await expect(waiting(page)).toHaveCount(0);

  const theirs = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
  });
  const them = await theirs.newPage();
  await signInWithEmail(them, email, '/sign-in?next=/ops');
  await them.waitForURL(/\/ops/);
  await them
    .getByLabel('Enrolment code')
    .fill(await emailedEnrolmentCode(email));
  await them.getByRole('button', { name: 'Continue' }).click();
  const secret =
    (await them.getByTestId('totp-secret').textContent())?.replace(/\s/g, '') ??
    '';
  await them.getByLabel('Authenticator code').fill(await totpNow(secret, 1n));
  await them.getByRole('button', { name: 'Confirm' }).click();
  await expect(nav(them).getByRole('link', { name: 'Search' })).toBeVisible();
  await expect(nav(them).getByRole('link')).toHaveText([
    'Overview',
    'Approvals',
    'Search',
    'Your access',
  ]);
  // Overview works without analytics: it says what it can and no more.
  await expect(
    them.getByRole('heading', { name: 'Pending approvals' }),
  ).toBeVisible();
  await expect(them.getByText('Couldn’t load the overview')).toHaveCount(0);
  await expectAccessible(them);
  await theirs.close();
});

test('a sensitive permission warns when ticked', async ({ page }, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.goto('/ops/staff/roles');
  await page.getByRole('button', { name: 'New role…' }).click();
  await expect(page.getByText('You’ve ticked sensitive access')).toHaveCount(0);
  await page.getByRole('checkbox', { name: /^payouts\.resolve/ }).check();
  await expect(page.getByText('You’ve ticked sensitive access')).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('checkbox', { name: /^payouts\.resolve/ }).uncheck();
  await expect(page.getByText('You’ve ticked sensitive access')).toHaveCount(0);
});

test('a person with an adjustment shows what differs from their role', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const email = `adjust.${randomUUID().slice(0, 8)}@example.com`;
  const [role] = await sql<{ id: string }>(
    `INSERT INTO roles (id, name, description) VALUES ($1, $2, '') RETURNING id`,
    [`r-${randomUUID().slice(0, 8)}`, `Adj ${randomUUID().slice(0, 6)}`],
  );
  await sql(
    `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'search.view'), ($1, 'issues.view')`,
    [role!.id],
  );
  const [user] = await sql<{ id: string }>(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [email],
  );
  await sql(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [user!.id, role!.id],
  );
  await page.goto('/ops/staff/people');
  const card = page.getByRole('article').filter({ hasText: email });
  await card.getByRole('button', { name: 'Adjust access…' }).click();
  await card.getByRole('checkbox', { name: /^analytics\.view/ }).check();
  await card.getByRole('checkbox', { name: /^issues\.view/ }).uncheck();
  await card.getByLabel('Why adjust their access?').fill(REASON);
  await card.getByRole('button', { name: 'Save access' }).click();
  await expect(
    card.getByText('Added beyond their role: analytics.view'),
  ).toBeVisible();
  await expect(
    card.getByText('Taken away from their role: issues.view'),
  ).toBeVisible();
  await expectAccessible(page);
  await sql(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [
    user!.id,
  ]);
});

test('editing a role shows who is affected before saving', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const email = `affected.${randomUUID().slice(0, 8)}@example.com`;
  const name = `Impact ${randomUUID().slice(0, 6)}`;
  const [role] = await sql<{ id: string }>(
    `INSERT INTO roles (id, name, description) VALUES ($1, $2, '') RETURNING id`,
    [`r-${randomUUID().slice(0, 8)}`, name],
  );
  await sql(
    `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'search.view')`,
    [role!.id],
  );
  const [user] = await sql<{ id: string }>(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [email],
  );
  await sql(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [user!.id, role!.id],
  );
  await page.goto('/ops/staff/roles');
  const card = page.getByRole('article').filter({ hasText: name });
  await card.getByRole('button', { name: 'Edit…' }).click();
  await card.getByRole('checkbox', { name: /^analytics\.view/ }).check();
  await expect(card.getByRole('button', { name: 'Save role' })).toHaveCount(0);
  await card.getByRole('button', { name: 'Review who is affected' }).click();
  await expect(card.getByText(email)).toBeVisible();
  await expect(card.getByText('Gains: analytics.view')).toBeVisible();
  await card.getByLabel('Why change this role?').fill(REASON);
  await card.getByRole('button', { name: 'Save role' }).click();
  await expect(card.getByText('✓ The role is saved')).toBeVisible();
  await sql(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [
    user!.id,
  ]);
});

test('a serious action says it is waiting, and a second person sees the exact change and approves', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);

  await askForFee(page, handle);
  await expect(waiting(page)).toBeVisible();
  await expect(page.getByText('Nothing has changed yet.')).toBeVisible();
  await expect(page.getByText('The fee is now')).toHaveCount(0);
  await expect(page.getByText('(standard)')).toBeVisible();
  await expectAccessible(page);

  // Asking again finds the same request, and says so.
  await askForFee(page, handle);
  await expect(page.getByText('This was already waiting')).toBeVisible();

  await other.page.goto('/ops');
  const overview = other.page.getByRole('region', {
    name: 'Pending approvals',
  });
  await expect(overview.getByText(`@${handle}`)).toBeVisible();
  await overview.getByRole('link', { name: 'Open approvals' }).click();
  const card = requestCard(other.page, handle);
  await expect(card.getByText('Change a page’s fee')).toBeVisible();
  await expect(card.getByText(`Set @${handle}'s fee to 7%`)).toBeVisible();
  await expect(card.getByText(REASON)).toBeVisible();
  await expectAccessible(other.page);

  // Keyboard only, from the button to done.
  await card.getByRole('button', { name: 'Approve…' }).focus();
  await other.page.keyboard.press('Enter');
  const code = card.getByLabel('Authenticator code');
  await expect(code).toBeFocused();
  await code.fill(await codeFor(other));
  await other.page.keyboard.press('Enter');
  await expect(other.page.getByText('Approved and done').first()).toBeVisible();

  await page.goto(`/ops/pages?handle=${handle}`);
  await expect(page.getByText('(set by staff for this page)')).toBeVisible();
  await other.context.close();
});

test('a second person can reject, with a reason, and the person who asked can cancel', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);

  await askForFee(page, handle, '6');
  await expect(waiting(page)).toBeVisible();
  await other.page.goto('/ops/approvals');
  const card = requestCard(other.page, handle);
  await card.getByRole('button', { name: 'Reject…' }).click();
  await card
    .getByLabel('Why reject it?')
    .fill('The fee was never agreed with them');
  await card.getByRole('button', { name: 'Reject request' }).click();
  await expect(
    other.page.getByText('Rejected. Nothing changed.'),
  ).toBeVisible();
  await expect(
    other.page.getByText('The fee was never agreed with them'),
  ).toBeVisible();

  await page.goto('/ops/approvals');
  await expect(
    page.getByText('The fee was never agreed with them'),
  ).toBeVisible();
  await page.goto(`/ops/pages?handle=${handle}`);
  await expect(page.getByText('(standard)')).toBeVisible();

  await askForFee(page, handle, '5');
  await expect(waiting(page)).toBeVisible();
  await page.goto('/ops/approvals');
  const mine = requestCard(page, handle).first();
  await expect(mine.getByRole('button', { name: 'Approve…' })).toHaveCount(0);
  await mine.getByRole('button', { name: 'Cancel my request' }).click();
  await expect(page.getByText('Cancelled. Nothing changed.')).toBeVisible();
  await other.context.close();
});

test('on approve: an outage says still waiting, a stale request says why, and it concerns you says so', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);
  await askForFee(page, handle, '4');
  await expect(waiting(page)).toBeVisible();

  await other.page.goto('/ops/approvals');
  const card = requestCard(other.page, handle);
  const refuse = (status: number, code: string, reason?: string) =>
    other.page.route('**/v1/ops/approvals/*/approve', (route) =>
      route.fulfill({
        status,
        json: { error: { code, message: 'x', ...(reason ? { reason } : {}) } },
      }),
    );
  const approve = async () => {
    if ((await card.getByLabel('Authenticator code').count()) === 0)
      await card.getByRole('button', { name: 'Approve…' }).click();
    await card.getByLabel('Authenticator code').fill('123456');
    await card.getByRole('button', { name: 'Approve and run' }).click();
  };

  await refuse(503, 'DEPENDENCY_UNAVAILABLE');
  await approve();
  await expect(other.page.getByText(/still waiting; try again/)).toBeVisible();
  await expect(card).toBeVisible();

  await other.page.unroute('**/v1/ops/approvals/*/approve');
  await refuse(403, 'APPROVAL_SUBJECT');
  await approve();
  await expect(other.page.getByText(/concerns you/)).toBeVisible();

  await other.page.unroute('**/v1/ops/approvals/*/approve');
  await refuse(409, 'APPROVAL_STALE', 'facts_changed');
  await approve();
  await expect(
    other.page.getByText(/the facts changed after it was asked/),
  ).toBeVisible();
  await other.context.close();
});

test('a page whose release is waiting still reads as frozen, and a failed read never reads as clear', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByRole('button', { name: 'Freeze withdrawals…' }).click();
  await page.getByLabel('Who reported it, and what did they say?').fill(REASON);
  await page.getByRole('button', { name: 'Freeze withdrawals' }).click();
  await expect(page.getByText('Withdrawals are frozen')).toBeVisible();
  const frozenPage = page.url();
  await page.getByRole('link', { name: 'the issue' }).click();
  await page.waitForURL(/\/ops\/issues\//);

  // Release is one person today, so a request can only be waiting if one was asked for before:
  // the screen must read it right whichever the server answers.
  await page.route('**/v1/ops/issues/*/resolve', (route) =>
    route.fulfill({ status: 202, json: { data: { requestId: randomUUID() } } }),
  );
  await page.getByRole('button', { name: 'Resolve…' }).click();
  await page.getByLabel('How was it settled?').selectOption('account_secured');
  await page
    .getByLabel(
      'I checked the current bank and the sign-in with the real owner.',
    )
    .check();
  await page.getByLabel('How was it resolved?').fill(REASON);
  await page.getByRole('button', { name: 'Resolve issue' }).click();
  await expect(waiting(page)).toBeVisible();
  await expect(page.getByText('Withdrawals stay frozen')).toBeVisible();
  await expect(
    page.getByText('The issue is resolved. Withdrawals are released.'),
  ).toHaveCount(0);
  await expect(
    page.locator('.ops-issue__status').getByText('Open', { exact: true }),
  ).toBeVisible();

  await page.goto(frozenPage);
  await expect(page.getByText('Withdrawals are frozen')).toBeVisible();

  await page.route('**/v1/ops/pages/*/withdrawal-freeze', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 500, json: { error: { code: 'X' } } })
      : route.continue(),
  );
  await page.reload();
  await expect(page.getByText('Freeze state unknown')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Freeze withdrawals…' }),
  ).toHaveCount(0);
});

test('an approver sees a money close’s outcome, and a recovery’s checks, masked address and mailbox match, never the payload', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);

  const issueId = await mismatchedTip(request, handle);
  await page.goto(`/ops/issues/${issueId}`);
  await page.getByRole('button', { name: 'Resolve…' }).click();
  await page.getByLabel('How was it settled?').selectOption('written_off');
  await page.getByLabel('How was it resolved?').fill(REASON);
  await page.getByRole('button', { name: 'Resolve issue' }).click();
  await expect(waiting(page)).toBeVisible();
  await expect(
    page.locator('.ops-issue__status').getByText('Open', { exact: true }),
  ).toBeVisible();

  const movedTo = `moved.${randomUUID().slice(0, 8)}@example.com`;
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByRole('button', { name: 'Move sign-in email…' }).click();
  await page.getByLabel('New sign-in email').fill(movedTo);
  await page
    .getByLabel('What did you check to be sure who this is?')
    .fill('Matched their last three tips on a call');
  await page.getByLabel('Why is this account moving?').fill(REASON);
  await page.getByRole('button', { name: 'Send code to new email' }).click();
  await expect(waiting(page)).toBeVisible();
  await expect(page.getByText('A code was sent')).toHaveCount(0);

  await other.page.goto('/ops/approvals');
  const close = other.page
    .getByRole('article')
    .filter({ hasText: issueId.slice(-6) });
  await expect(close.getByText('Close a money issue')).toBeVisible();
  await expect(close.getByText(/as: Written off by TipMe/)).toBeVisible();
  await expect(close.getByText(/payment mismatch/)).toBeVisible();

  const move = other.page
    .getByRole('article')
    .filter({ hasText: 'Matched their last three tips on a call' });
  await expect(
    move.getByText('Move an account to a new email address'),
  ).toBeVisible();
  await expect(move.getByText(/matches no staff mailbox/)).toBeVisible();
  const words = (await move.textContent()) ?? '';
  expect(words).not.toContain(movedTo);
  const screen = (await other.page.content()) ?? '';
  expect(screen).not.toContain(movedTo);
  expect(screen).not.toContain('"newEmail"');
  expect(screen).not.toContain('"payload"');

  // Closes both, so they don't sit in another test's list.
  for (const article of [close, move]) {
    await article.getByRole('button', { name: 'Reject…' }).click();
    await article.getByLabel('Why reject it?').fill(REASON);
    await article.getByRole('button', { name: 'Reject request' }).click();
    await expect(article).toHaveCount(0);
  }
  await other.context.close();
});

test('every other staff answer that waits reads as waiting: add, reset, access', async ({
  page,
  browser,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  // Whichever the server would decide, these screens must read a request as a request.
  const wait = { status: 202, json: { data: { requestId: randomUUID() } } };
  await page.route(
    /\/v1\/ops\/staff(\/[^/]+\/(role|access|reset-authenticator))?$/,
    (route) =>
      route.request().method() === 'GET'
        ? route.fallback()
        : route.fulfill(wait),
  );
  // Someone really set up, as Reset is only offered to them.
  const other = await secondOwner(browser, testInfo);
  const email = other.email;
  await page.goto('/ops/staff/people');
  await page.getByRole('button', { name: 'Add a person…' }).click();
  await page.getByLabel('Their email').fill(`a.${email}`);
  await page.getByLabel('Role', { exact: true }).selectOption('owner');
  await expect(
    page.getByText('This role holds sensitive access'),
  ).toBeVisible();
  await page.getByLabel('Why are you adding them?').fill(REASON);
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(waiting(page)).toBeVisible();
  await expect(page.getByText('Invitation sent')).toHaveCount(0);

  const card = page.getByRole('article').filter({ hasText: email });
  await card.getByRole('button', { name: 'Reset authenticator…' }).click();
  await card.getByLabel('Why reset their authenticator?').fill(REASON);
  await card.getByRole('button', { name: 'Reset authenticator' }).click();
  await expect(
    card.getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible();
  await expect(card.getByText('Their authenticator is reset')).toHaveCount(0);

  await card.getByRole('button', { name: 'Adjust access…' }).click();
  await card.getByRole('checkbox', { name: /^search\.view/ }).uncheck();
  await card.getByLabel('Why adjust their access?').fill(REASON);
  await card.getByRole('button', { name: 'Save access' }).click();
  await expect(card.getByText('Their access is changed')).toHaveCount(0);
  await expect(card.getByText('Taken away from their role')).toHaveCount(0);

  await other.context.close();
});

test('a money close that is rate limited or already resolved says so', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByRole('button', { name: 'Freeze withdrawals…' }).click();
  await page.getByLabel('Who reported it, and what did they say?').fill(REASON);
  await page.getByRole('button', { name: 'Freeze withdrawals' }).click();
  await page.getByRole('link', { name: 'the issue' }).click();
  await page.waitForURL(/\/ops\/issues\//);
  const close = async () => {
    await page
      .getByLabel('How was it settled?')
      .selectOption('account_secured');
    await page
      .getByLabel(
        'I checked the current bank and the sign-in with the real owner.',
      )
      .check();
    await page.getByLabel('How was it resolved?').fill(REASON);
    await page.getByRole('button', { name: 'Resolve issue' }).click();
  };
  await page.getByRole('button', { name: 'Resolve…' }).click();
  await page.route('**/v1/ops/issues/*/resolve', (route) =>
    route.fulfill({
      status: 429,
      json: { error: { code: 'RATE_LIMITED', message: 'x' } },
    }),
  );
  await close();
  await expect(page.getByText(/a lot of these this hour/)).toBeVisible();
  await page.unroute('**/v1/ops/issues/*/resolve');
  await page.route('**/v1/ops/issues/*/resolve', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'ISSUE_RESOLVED', message: 'x' } },
    }),
  );
  await close();
  await expect(page.getByText(/already resolved/)).toBeVisible();
});

test('the screens fit 320px and work by keyboard', async ({
  page,
  browser,
}, testInfo) => {
  // Two enrolments and five accessibility scans: 17-24s normally, and over 30s on a busy machine.
  test.slow();
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  const owner = await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);
  await askForFee(other.page, handle, '3');
  await expect(waiting(other.page)).toBeVisible();

  await page.setViewportSize({ width: 320, height: 700 });
  for (const path of [
    '/ops',
    '/ops/approvals',
    '/ops/staff',
    '/ops/staff/people',
    '/ops/staff/roles',
  ]) {
    await page.goto(path);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await fitsViewport(page), path).toBe(true);
    await expectAccessible(page);
  }
  await page.goto('/ops/approvals');
  await requestCard(page, handle)
    .getByRole('button', { name: 'Approve…' })
    .click();
  expect(await fitsViewport(page)).toBe(true);

  // The code prompt: focus goes in, Escape leaves it, nothing happens, focus comes back.
  await codeWentStale(owner);
  await page.goto('/ops/staff/roles');
  await page.getByRole('button', { name: 'New role…' }).click();
  await page.getByLabel('Role name').fill(`Kb ${randomUUID().slice(0, 6)}`);
  await page.getByLabel('Why this role?').fill(REASON);
  const create = page.getByRole('button', { name: 'Create role' });
  await create.focus();
  await page.keyboard.press('Enter');
  const prompt = page.getByRole('dialog', { name: 'Enter a fresh code' });
  await expect(prompt).toBeVisible();
  await expect(prompt.getByLabel('Authenticator code')).toBeFocused();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText(/fresh authenticator code/)).toBeVisible();
  await expect(create).toBeFocused();

  await create.focus();
  await page.keyboard.press('Enter');
  await prompt.getByLabel('Authenticator code').fill(await codeFor(owner));
  await page.keyboard.press('Enter');
  await expect(prompt).toHaveCount(0);
  await expect(page.getByText('The role is created')).toBeVisible();
  await other.context.close();
});

/** A real issue, dressed by the browser as a stuck withdrawal whose provider read offers `offers`. */
async function stuckWithdrawalScreen(
  page: Page,
  issueId: string,
  offers: Record<string, unknown>,
) {
  const payoutId = randomUUID();
  await page.route(`**/v1/ops/issues/${issueId}`, async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.issue.kind = 'payout_unresolved';
    body.data.issue.subject = { payoutId };
    await route.fulfill({ response, json: body });
  });
  await page.route(`**/v1/ops/issues/${issueId}/payout-read`, (route) =>
    route.fulfill({
      json: {
        data: {
          issueId,
          issueStatus: 'open',
          payoutStatus: 'PROCESSING',
          startStep: 'payout',
          startAttemptedAt: null,
          holdActive: false,
          takeoverReported: false,
          parkedEvent: false,
          openConflict: false,
          destinationReplaced: false,
          holdTouched: false,
          read: {
            state: 'absent',
            referenceTail: null,
            differing: [],
            failureReason: null,
          },
          offers: {
            applyReported: null,
            resume: false,
            markFailed: false,
            ...offers,
          },
        },
      },
    }),
  );
}

test('payout-apply and mark-failed: a 202 reads as waiting beside the button, and the form closes', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  const issueId = await mismatchedTip(request, handle);
  await stuckWithdrawalScreen(page, issueId, {
    applyReported: 'paid',
    markFailed: true,
  });
  const wait = { status: 202, json: { data: { requestId: randomUUID() } } };
  await page.route('**/payout-apply', (route) => route.fulfill(wait));
  await page.route('**/payout-mark-failed', (route) => route.fulfill(wait));
  await page.goto(`/ops/issues/${issueId}`);
  const tools = page.getByRole('region', { name: 'Act on this withdrawal' });

  await tools.getByRole('button', { name: 'Ask the provider' }).click();
  await tools.getByRole('button', { name: 'Record it as paid…' }).click();
  await tools.getByLabel('Why record this now?').fill(REASON);
  await tools.getByRole('button', { name: 'Record as paid' }).click();
  await expect(tools.getByText('Waiting for a second person')).toBeVisible();
  await expect(tools.getByText(/was recorded through/)).toHaveCount(0);
  await expect(
    tools.getByRole('button', { name: 'Record as paid' }),
  ).toHaveCount(0);

  await tools.getByRole('button', { name: 'Ask the provider' }).click();
  await tools.getByLabel('What did you find at the provider?').fill(REASON);
  await tools
    .getByLabel(
      'I checked the provider’s dashboard, and this payout is not there.',
    )
    .check();
  await tools.getByRole('button', { name: 'Mark failed and release' }).click();
  await expect(tools.getByText('Waiting for a second person')).toBeVisible();
  await expect(
    tools.getByLabel('What did you find at the provider?'),
  ).toHaveCount(0);
  await expect(tools.getByText(/is marked failed/)).toHaveCount(0);
  await expectAccessible(page);

  // A lone admin whose own request waits is told the way out, not to ask the provider again.
  await page.unroute('**/payout-apply');
  await page.route('**/payout-apply', (route) =>
    route.fulfill({
      status: 409,
      json: { error: { code: 'APPROVAL_ALREADY_PENDING', message: 'x' } },
    }),
  );
  await tools.getByRole('button', { name: 'Ask the provider' }).click();
  await tools.getByRole('button', { name: 'Record it as paid…' }).click();
  await tools.getByLabel('Why record this now?').fill(REASON);
  await tools.getByRole('button', { name: 'Record as paid' }).click();
  await expect(tools.getByText(/Cancel it in Approvals/)).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a real role change and a real role edit wait, and neither shows as done', async ({
  page,
  browser,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);
  const name = `Wait ${randomUUID().slice(0, 6)}`;
  const [role] = await sql<{ id: string }>(
    `INSERT INTO roles (id, name, description) VALUES ($1, $2, '') RETURNING id`,
    [`r-${randomUUID().slice(0, 8)}`, name],
  );
  await sql(
    `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'search.view')`,
    [role!.id],
  );
  const email = `moves.${randomUUID().slice(0, 8)}@example.com`;
  const [user] = await sql<{ id: string }>(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [email],
  );
  await sql(
    `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, $2, now(), now())`,
    [user!.id, role!.id],
  );

  await page.goto('/ops/staff/people');
  const person = page.getByRole('article').filter({ hasText: email });
  await person.getByRole('button', { name: 'Change role…' }).click();
  await person.getByLabel('New role').selectOption('owner');
  await person.getByLabel('Why change their role?').fill(REASON);
  await person.getByRole('button', { name: 'Change role' }).click();
  await expect(person.getByText('Waiting for a second person')).toBeVisible();
  await expect(person.getByText(name, { exact: true })).toBeVisible();
  await expect(person.getByText('Their role is changed')).toHaveCount(0);

  await page.goto('/ops/staff/roles');
  const card = page.getByRole('article').filter({ hasText: name });
  await card.getByRole('button', { name: 'Edit…' }).click();
  await card.getByRole('checkbox', { name: /^search\.view/ }).uncheck();
  await card.getByRole('checkbox', { name: /^audit\.view/ }).check();
  await card.getByRole('button', { name: 'Review who is affected' }).click();
  await card.getByLabel('Why change this role?').fill(REASON);
  await card.getByRole('button', { name: 'Save role' }).click();
  await expect(card.getByText('Waiting for a second person')).toBeVisible();
  await expect(card.getByText('The role is saved')).toHaveCount(0);

  await other.page.goto('/ops/approvals');
  const asked = other.page
    .getByRole('article')
    .filter({ hasText: `the role ${name}` });
  await expect(asked.getByText(/add audit\.view/)).toBeVisible();
  await expect(asked.getByText(/remove search\.view/)).toBeVisible();
  await sql(`UPDATE staff SET revoked_at = now() WHERE user_id = $1`, [
    user!.id,
  ]);
  await other.context.close();
});

test('a mail switch that waits reads as waiting (stubbed), and the active provider stays', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.route('**/v1/ops/providers/mail', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.providers = body.data.providers.map(
      (card: Record<string, unknown>, index: number) => ({
        ...card,
        active: index !== 0,
        canActivate: index === 0,
      }),
    );
    await route.fulfill({ response, json: body });
  });
  await page.route('**/v1/ops/providers/mail/active', (route) =>
    route.fulfill({ status: 202, json: { data: { requestId: randomUUID() } } }),
  );
  await page.goto('/ops/providers');
  await page.getByRole('button', { name: 'Make active' }).first().click();
  await page.getByLabel('Why are you switching?').fill(REASON);
  await page.getByRole('button', { name: 'Switch provider' }).click();
  await expect(page.getByText('Waiting for a second person')).toBeVisible();
  await expect(page.getByText(/is now the active provider/)).toHaveCount(0);
  // The re-read after a switch may still be in flight through the stub.
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

test('a lost answer says the result is unknown and re-reads; roles unknown blocks saving access', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByRole('button', { name: 'Freeze withdrawals…' }).click();
  await page.getByLabel('Who reported it, and what did they say?').fill(REASON);
  await page.getByRole('button', { name: 'Freeze withdrawals' }).click();
  await page.getByRole('link', { name: 'the issue' }).click();
  await page.waitForURL(/\/ops\/issues\//);
  await page.route('**/v1/ops/issues/*/resolve', (route) =>
    route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR' } } }),
  );
  let reads = 0;
  page.on('request', (r) => {
    if (r.method() === 'GET' && /\/v1\/ops\/issues\/[^/]+$/.test(r.url()))
      reads += 1;
  });
  await page.getByRole('button', { name: 'Resolve…' }).click();
  await page.getByLabel('How was it settled?').selectOption('account_secured');
  await page
    .getByLabel(
      'I checked the current bank and the sign-in with the real owner.',
    )
    .check();
  await page.getByLabel('How was it resolved?').fill(REASON);
  await page.getByRole('button', { name: 'Resolve issue' }).click();
  await expect(
    page.getByText(/can’t say whether it went through/),
  ).toBeVisible();
  await expect(page.getByText(/nothing changed/i)).toHaveCount(0);
  await expect.poll(() => reads).toBeGreaterThan(0);

  await page.route('**/v1/ops/staff/roles', (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 500,
          json: { error: { code: 'INTERNAL_ERROR' } },
        })
      : route.fallback(),
  );
  await page.goto('/ops/staff/people');
  await expect(page.getByRole('article').first()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Adjust access…' }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change role…' })).toHaveCount(
    0,
  );
  await expect(page.getByText(/Couldn’t read the roles/).first()).toBeVisible();
});

test('the screens that gained an outcome fit 320px; focus lands on the outcome', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  await page.setViewportSize({ width: 320, height: 700 });
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByLabel('New TipMe fee (%)').fill('7');
  await feeForm(page).getByLabel('Reason').fill(REASON);
  await page.getByRole('button', { name: 'Set this page’s fee' }).click();
  const outcome = page.getByTestId('action-outcome');
  await expect(outcome).toBeFocused();
  expect(await fitsViewport(page)).toBe(true);
  await page.goto('/ops/providers');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByRole('button', { name: 'Freeze withdrawals…' }).click();
  await page.getByLabel('Who reported it, and what did they say?').fill(REASON);
  await page.getByRole('button', { name: 'Freeze withdrawals' }).click();
  await page.getByRole('link', { name: 'the issue' }).click();
  await page.waitForURL(/\/ops\/issues\//);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
});

test('a finance role with fees.manage only can find a page and change its fee', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  const person = await enrolOwner(page, testInfo);
  const [role] = await sql<{ id: string }>(
    `INSERT INTO roles (id, name, description) VALUES ($1, $1, '') RETURNING id`,
    [`r-${randomUUID().slice(0, 8)}`],
  );
  await sql(
    `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'fees.manage')`,
    [role!.id],
  );
  await sql(
    `UPDATE staff SET role_id = $2 WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
    [person.email, role!.id],
  );
  await page.goto('/ops');
  await nav(page).getByRole('link', { name: 'Pages' }).click();
  await page.getByLabel('Handle').fill(handle);
  await page.getByRole('button', { name: 'Find page' }).click();
  await expect(page.getByLabel('New TipMe fee (%)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Make Pro…' })).toHaveCount(0);
});

test('someone without usernames.manage sees no Usernames link', async ({
  page,
}, testInfo) => {
  const person = await enrolOwner(page, testInfo);
  // The Owner holds it.
  await expect(
    nav(page).getByRole('link', { name: 'Usernames' }),
  ).toBeVisible();
  const [role] = await sql<{ id: string }>(
    `INSERT INTO roles (id, name, description) VALUES ($1, $1, '') RETURNING id`,
    [`r-${randomUUID().slice(0, 8)}`],
  );
  await sql(
    `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'pages.plan'), ($1, 'search.view')`,
    [role!.id],
  );
  await sql(
    `UPDATE staff SET role_id = $2 WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
    [person.email, role!.id],
  );
  await page.goto('/ops');
  await expect(nav(page).getByRole('link', { name: 'Pages' })).toBeVisible();
  await expect(nav(page).getByRole('link', { name: 'Usernames' })).toHaveCount(
    0,
  );
  // Going there directly shows no controls; the server refuses every call anyway.
  await page.goto('/ops/usernames');
  await expect(page.getByText('Not part of your role')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Check' })).toHaveCount(0);
});
