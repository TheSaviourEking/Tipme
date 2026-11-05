import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signUpRecipient } from './helpers';
import { enrolOwner, secondOwner, sql } from './ops-helpers';

// What a screen says for answers that are hard to cause on purpose, so the answers are stubbed.
const REASON = 'Checked with the person on a call today';
const LINK = {
  delivery: 'suppressed',
  enrolmentExpiresAt: new Date(Date.now() + 1_800_000).toISOString(),
};

test('the withdrawals switch never says "not switched off" when it can’t know', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.route('**/v1/ops/withdrawals-switch', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({
          status: 503,
          json: { error: { code: 'INTERNAL', message: 'x' } },
        })
      : route.continue(),
  );
  await page.goto('/ops');
  const control = page.getByTestId('withdrawals-switch');
  await control
    .getByRole('button', { name: 'Switch off all withdrawals…' })
    .click();
  await control.getByLabel('Why stop all withdrawals?').fill(REASON);
  await control.getByRole('button', { name: 'Switch off' }).click();
  await expect(control.getByText(/We can’t say whether/)).toBeVisible();
  await expect(control.getByText(/Not switched off/)).toHaveCount(0);
});

test('a history that can’t be read says so, and not "no decisions yet"', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  await page.route(/\/v1\/ops\/approvals$/, (route) =>
    route.fulfill({
      status: 500,
      json: { error: { code: 'INTERNAL', message: 'x' } },
    }),
  );
  await page.goto('/ops/approvals');
  await expect(page.getByText('Couldn’t load the history')).toBeVisible();
  await expect(page.getByText('No decisions yet.')).toHaveCount(0);
});

test('People: the hint matches the role, a dead address warns, and Remove confirms', async ({
  page,
  browser,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);
  const roleName = `Hint ${randomUUID().slice(0, 6)}`;
  await page.route(/\/v1\/ops\/staff$/, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 201, json: { data: LINK } })
      : route.continue(),
  );
  await page.route('**/reset-authenticator', (route) =>
    route.fulfill({ status: 200, json: { data: LINK } }),
  );
  await page.route('**/v1/ops/staff/*/remove', (route) =>
    route.fulfill({ status: 200, json: { data: {} } }),
  );
  await page.goto('/ops/staff/roles');
  await page.getByRole('button', { name: 'New role…' }).click();
  await page.getByLabel('Role name').fill(roleName);
  await page.getByLabel('Why this role?').fill(REASON);
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByText(roleName).first()).toBeVisible();
  await page.goto('/ops/staff/people');

  const card = page.getByRole('article').filter({ hasText: other.email });
  await card.getByRole('button', { name: 'Change role…' }).click();
  await card.getByLabel('New role').selectOption({ label: roleName });
  await expect(card.getByText(/personal adjustments stay/)).toBeVisible();
  await card.getByLabel('New role').selectOption('owner');
  await expect(
    card.getByText(/personal adjustments are cleared/),
  ).toBeVisible();
  await expect(card.getByText(/personal adjustments stay/)).toHaveCount(0);
  await page.reload();

  await page.getByRole('button', { name: 'Add a person…' }).click();
  await page
    .getByLabel('Their email')
    .fill(`dead.${randomUUID().slice(0, 6)}@example.com`);
  await page
    .getByLabel('Role', { exact: true })
    .selectOption({ label: roleName });
  await page.getByLabel('Why are you adding them?').fill(REASON);
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(
    page.getByText('The link won’t arrive', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Invitation sent')).toHaveCount(0);

  await card.getByRole('button', { name: 'Reset authenticator…' }).click();
  await card.getByLabel('Why reset their authenticator?').fill(REASON);
  await card.getByRole('button', { name: 'Reset authenticator' }).click();
  await expect(
    card.getByText('The link won’t arrive', { exact: true }),
  ).toBeVisible();
  await expect(card.getByText('Done', { exact: true })).toHaveCount(0);

  await card.getByRole('button', { name: 'Remove…' }).click();
  await card.getByLabel('Why remove them?').fill(REASON);
  await card.getByRole('button', { name: 'Remove from staff' }).click();
  await expect(
    page.getByText(/is off staff, and their admin sessions ended/),
  ).toBeVisible();
  await other.context.close();
});

test('granting fee-free tips that waits reads as waiting, not as granted', async ({
  page,
  browser,
}, testInfo) => {
  const { handle } = await signUpRecipient(
    await (await browser.newContext()).newPage(),
    testInfo,
  );
  await enrolOwner(page, testInfo);
  await page.route('**/fee-free', (route) =>
    route.fulfill({
      status: 202,
      json: { data: { requestId: randomUUID() } },
    }),
  );
  await page.goto(`/ops/pages?handle=${handle}`);
  await page.getByLabel('Fee-free tips to grant').fill('2');
  await page
    .locator('form')
    .filter({ has: page.getByLabel('Fee-free tips to grant') })
    .getByLabel('Reason')
    .fill(REASON);
  await page.getByRole('button', { name: 'Grant fee-free tips' }).click();
  await expect(
    page.getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/fee-free tips granted/)).toHaveCount(0);
});

test('only an owner is offered Reset authenticator; a manager isn’t, since it would refuse them', async ({
  page,
  browser,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);
  await page.goto('/ops/staff/people');
  const card = page.getByRole('article').filter({ hasText: other.email });
  await expect(
    card.getByRole('button', { name: 'Reset authenticator…' }),
  ).toBeVisible();

  await page.route('**/v1/ops/me', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { data: { ...body.data, role: 'manager' } },
    });
  });
  await page.reload();
  await expect(card.getByRole('button', { name: 'Remove…' })).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Reset authenticator…' }),
  ).toHaveCount(0);
  await other.context.close();
});

test('holding only providers.manage or email.read opens those screens', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  for (const [permission, link, heading] of [
    ['providers.manage', 'Providers', 'Providers'],
    ['email.read', 'Email', 'Email'],
  ] as const) {
    await page.route('**/v1/ops/me', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: {
          data: { ...body.data, role: 'r', permissions: [permission] },
        },
      });
    });
    await page.goto('/ops');
    await page
      .getByRole('navigation', { name: 'Admin' })
      .getByRole('link', { name: link, exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: heading, level: 1 }),
    ).toBeVisible();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
  }
});

// The admin menu has many links: it stays one row and scrolls sideways, never wrapping a lone link
// onto a second line, and the open page's link is always in view.
for (const [label, width] of [
  ['desktop', 1280],
  ['phone', 360],
] as const)
  test(`the admin menu is one row on a ${label}, and every link can be reached`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 800 });
    await enrolOwner(page, testInfo);
    await page.goto('/ops');
    const nav = page.getByRole('navigation', { name: 'Admin' });
    const links = nav.getByRole('link');
    // The menu appears once the admin area has loaded.
    await expect(links.last()).toBeAttached();
    expect(await links.count()).toBeGreaterThan(5);
    const tops = await links.evaluateAll((all) =>
      all.map((link) => Math.round(link.getBoundingClientRect().top)),
    );
    expect(new Set(tops).size).toBe(1);
    // The last link opens its page, and that page's link is scrolled into view.
    await links.last().click();
    await expect(
      page.locator('nav[aria-label="Admin"] [aria-current="page"]'),
    ).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });

test('a report after the takeover closed: the card stops pointing at the closed issue, and leads to the new one', async ({
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
  const first = page.getByRole('link', { name: 'the issue' });
  const firstHref = await first.getAttribute('href');
  const firstId = firstHref!.split('/').pop()!;
  // As closing it leaves things when another open issue keeps the hold (integration covers the close).
  await sql(
    `UPDATE issues SET status = 'resolved', resolved_at = now(), resolution_outcome = 'account_secured' WHERE id = $1`,
    [firstId],
  );

  await page.reload();
  await expect(page.getByText('Withdrawals are still frozen')).toBeVisible();
  await expect(page.getByText('Withdrawals are frozen')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'the issue' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Record a new report…' }).click();
  await page.getByLabel('Who reported it, and what did they say?').fill(REASON);
  await page.getByRole('button', { name: 'Record report' }).click();
  const next = page.getByRole('link', { name: 'the issue' });
  await expect(next).toBeVisible();
  expect(await next.getAttribute('href')).not.toBe(firstHref);
  await next.click();
  await page.waitForURL(/\/ops\/issues\//);
  await expect(page.getByRole('button', { name: 'Resolve…' })).toBeVisible();
  await expect(
    page.getByText(`Earlier report, now closed: ${firstId}.`),
  ).toBeVisible();
});
