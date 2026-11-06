import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { expectAccessible } from './helpers';
import {
  codeFor,
  codeWentStale,
  enrolOwner,
  openOpsLink,
  sql,
  type TestInfo,
} from './ops-helpers';

// The changelog in admin (changelog plan, PR 5). Entries are seeded with SQL, a year ahead of now so
// they head the newest-first list whatever else is there, with random numbers so parallel projects
// never share one.
const REASON = 'Recipients asked for this in the pilot';

type Seed = {
  userText?: string | null;
  audience?: 'staff' | 'everyone' | 'pro' | 'early_access';
  published?: boolean;
  live?: boolean;
  withdrawnBy?: string;
};

async function seed(staffText: string, over: Seed = {}): Promise<number> {
  const number = randomInt(100_000, 2_000_000_000);
  const userText =
    over.userText === undefined ? 'You can pin a note.' : over.userText;
  const audience = over.audience ?? (userText === null ? 'staff' : 'everyone');
  await sql(
    `INSERT INTO changelog_entries
       (pr_number, merge_sha, merged_at, pr_title, staff_text, user_text, audience,
        published_text, published_audience, published_revision, approved_at,
        live_at, live_version, withdrawn_at, withdrawn_by, withdrawn_reason)
     VALUES ($1, $2, now() + interval '1 year', $3, $3, $4, $5,
        CASE WHEN $6 THEN $4 END, CASE WHEN $6 THEN $5 END, CASE WHEN $6 THEN 1 END,
        CASE WHEN $6 THEN now() END,
        CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN 'abcdef123456' END,
        CASE WHEN $8::uuid IS NOT NULL THEN now() END, $8::uuid,
        CASE WHEN $8::uuid IS NOT NULL THEN 'Withdrawn while testing' END)`,
    [
      number,
      randomBytes(20).toString('hex'),
      staffText,
      userText,
      audience,
      over.published ?? false,
      over.live ?? false,
      over.withdrawnBy ?? null,
    ],
  );
  return number;
}

const userIdOf = async (email: string) =>
  (
    await sql<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [email],
    )
  )[0]!.id;

const published = async (number: number) =>
  (
    await sql<{
      published_text: string | null;
      published_audience: string | null;
      published_revision: number | null;
    }>(
      `SELECT published_text, published_audience, published_revision
         FROM changelog_entries WHERE pr_number = $1`,
      [number],
    )
  )[0]!;

const entryRow = (page: Page, number: number) =>
  page.getByRole('article').filter({
    has: page.getByRole('heading', { name: `#${number}`, exact: true }),
  });

/**
 * A second staff member who holds only changelog.edit, signed in in their own browser: enrolled as
 * the helpers do, then moved to a role made for this test.
 */
async function editor(
  browser: Browser,
  testInfo: TestInfo & { project: { use: { baseURL?: string } } },
) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const person = await enrolOwner(page, testInfo);
  const [role] = await sql<{ id: string }>(
    `INSERT INTO roles (id, name, description) VALUES ($1, $1, '') RETURNING id`,
    [`cl-${randomUUID().slice(0, 8)}`],
  );
  await sql(
    `INSERT INTO role_permissions (role_id, permission) VALUES ($1, 'changelog.edit')`,
    [role!.id],
  );
  await sql(
    `UPDATE staff SET role_id = $1
      WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($2))`,
    [role!.id, person.email],
  );
  return { context, page, ...person };
}

async function approveInApprovals(
  page: Page,
  person: { email: string; secret: string },
  number: number,
) {
  await page.goto('/ops/approvals');
  const request = page
    .getByRole('article')
    .filter({ hasText: `#${number}` })
    .first();
  await request.getByRole('button', { name: 'Approve…' }).click();
  await request.getByLabel('Authenticator code').fill(await codeFor(person));
  await request.getByRole('button', { name: 'Approve and run' }).click();
}

test('the owner sees every merged PR and filters Drafts, For users and Staff only @mobile', async ({
  page,
}, testInfo) => {
  const { email } = await enrolOwner(page, testInfo);
  const draft = await seed('feat: pin a note — a draft for users');
  const recorded = await seed('ci: faster checks — staff only', {
    userText: null,
  });
  const live = await seed('feat: QR card — live for users', {
    published: true,
    live: true,
  });
  const withdrawn = await seed('feat: old idea — withdrawn', {
    published: true,
    withdrawnBy: await userIdOf(email),
  });

  // Through the menu: at phone width admin links sit in the Menu sheet.
  await openOpsLink(page, 'Changelog');
  await expect(page.getByRole('heading', { name: 'Changelog' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(entryRow(page, draft)).toContainText('Draft');
  await expect(entryRow(page, draft)).toContainText(
    'feat: pin a note — a draft for users',
  );
  await expect(entryRow(page, recorded)).toContainText('Recorded');
  await expect(entryRow(page, live)).toContainText(
    /Live \d{1,2} [A-Z][a-z]{2}/,
  );
  await expect(entryRow(page, withdrawn)).toContainText('Withdrawn');
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Drafts' }).click();
  await expect(page).toHaveURL(/\/ops\/changelog\?view=drafts$/);
  await expect(page.getByRole('button', { name: 'Drafts' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(entryRow(page, draft)).toBeVisible();
  await expect(entryRow(page, recorded)).toHaveCount(0);
  await expect(entryRow(page, live)).toHaveCount(0);

  await page.getByRole('button', { name: 'For users' }).click();
  await expect(page).toHaveURL(/view=users$/);
  await expect(entryRow(page, live)).toBeVisible();
  await expect(entryRow(page, draft)).toHaveCount(0);
  // Withdrawn entries are not what users read: they stay in All only.
  await expect(entryRow(page, withdrawn)).toHaveCount(0);

  await page.getByRole('button', { name: 'Staff only' }).click();
  await expect(page).toHaveURL(/view=staff$/);
  await expect(entryRow(page, recorded)).toBeVisible();
  await expect(entryRow(page, live)).toHaveCount(0);
  await expectAccessible(page);

  // The URL keeps the filter on a reload.
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Staff only' }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(entryRow(page, recorded)).toBeVisible();

  await entryRow(page, recorded)
    .getByRole('link', { name: `#${recorded}` })
    .click();
  await expect(
    page.getByRole('heading', { name: `#${recorded} ci: faster checks` }),
  ).toBeVisible();
});

test('the owner edits the user text, sees the exact user line ("On Pro, …" for Pro), approves with a code, and the state reads Approved', async ({
  page,
}, testInfo) => {
  const owner = await enrolOwner(page, testInfo);
  const number = await seed('feat: starting amounts');
  await page.goto(`/ops/changelog/${number}`);
  await expect(page.getByText('Draft', { exact: true })).toBeVisible();

  await page.getByLabel('For users').fill('You can pick a starting amount.');
  await expect(page.getByText('31 of 280 characters')).toBeVisible();
  await page.getByLabel(/^Pro pages \(/).check();
  await expect(page.getByTestId('changelog-preview')).toHaveText(
    'On Pro, you can pick a starting amount.',
  );
  // Approval is for what is saved.
  await expect(page.getByRole('button', { name: 'Approve…' })).toHaveCount(0);
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(
    page.getByText('Saved. Users don’t read this text until it is approved.'),
  ).toBeAttached();

  // The code has gone stale since enrolling: approving asks for a fresh one first.
  await codeWentStale(owner);
  await page.getByRole('button', { name: 'Approve…' }).click();
  await page.getByLabel('Why show this to users?').fill(REASON);
  await page.getByRole('button', { name: 'Approve and show users' }).click();
  await expect(
    page.getByRole('heading', { name: 'Enter a fresh code' }),
  ).toBeVisible();
  await page.getByLabel('Authenticator code').fill(await codeFor(owner));
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(
    page.locator('.tm-slip').filter({ hasText: 'Approved' }),
  ).toBeVisible();
  await expect(
    page.getByText('Approved · not on staging yet', { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'What users read now' }),
  ).toContainText('On Pro, you can pick a starting amount.');
  expect(await published(number)).toEqual({
    published_text: 'You can pick a starting amount.',
    published_audience: 'pro',
    published_revision: 2,
  });
  await expectAccessible(page);
});

test('a text naming the payment partner is refused next to the field with the reason', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const number = await seed('fix: payouts');
  await page.goto(`/ops/changelog/${number}`);
  const field = page.getByLabel('For users');
  await field.fill('Payouts via Bachs are faster now.');
  // Said at once, tied to the field.
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('.tm-field-error')).toContainText(
    'It names our payment partner.',
  );
  await expectAccessible(page);

  // Saving is allowed (staff are still writing); approving is refused by the server too.
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('button', { name: 'Approve…' })).toBeVisible();
  await page.getByRole('button', { name: 'Approve…' }).click();
  await page.getByLabel('Why show this to users?').fill(REASON);
  await page.getByRole('button', { name: 'Approve and show users' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Not approved' }),
  ).toContainText('can’t be shown to users');
  await expect(page.locator('.tm-field-error')).toContainText(
    'It names our payment partner.',
  );
  expect((await published(number)).published_revision).toBeNull();

  // A licence claim is named too.
  await field.fill('TipMe is now licensed.');
  await expect(page.locator('.tm-field-error')).toContainText(
    'licensed, regulated, approved or guaranteed',
  );
});

test('an editor asks for approval; it appears on Approvals for the owner; approving there publishes it', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const owner = await enrolOwner(page, testInfo);
  const them = await editor(browser, testInfo);
  const number = await seed('feat: supporter notes');

  await them.page.goto(`/ops/changelog/${number}`);
  await expect(them.page.getByRole('button', { name: 'Approve…' })).toHaveCount(
    0,
  );
  await them.page.getByRole('button', { name: 'Ask for approval…' }).click();
  await them.page.getByLabel('Why should users see this?').fill(REASON);
  await expectAccessible(them.page);
  await them.page.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    them.page.locator('.tm-slip').filter({ hasText: 'Waiting in Approvals' }),
  ).toContainText('A publisher decides it in Approvals.');
  await expect(
    them.page.getByText('Draft · Waiting in Approvals'),
  ).toBeVisible();
  expect((await published(number)).published_revision).toBeNull();

  await approveInApprovals(page, owner, number);
  await expect
    .poll(async () => (await published(number)).published_revision)
    .toBe(1);
  expect((await published(number)).published_text).toBe('You can pin a note.');

  await them.page.reload();
  await expect(
    them.page.getByText('Approved · not on staging yet'),
  ).toBeVisible();
  await expectAccessible(them.page);
  await them.context.close();
});

test('editing after asking: the entry says so, and Approvals says the request went stale', async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const owner = await enrolOwner(page, testInfo);
  const them = await editor(browser, testInfo);
  const number = await seed('feat: thank-you cards');

  await them.page.goto(`/ops/changelog/${number}`);
  await them.page.getByRole('button', { name: 'Ask for approval…' }).click();
  await them.page.getByLabel('Why should users see this?').fill(REASON);
  await them.page.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    them.page.locator('.tm-slip').filter({ hasText: 'Waiting in Approvals' }),
  ).toBeVisible();

  await them.page
    .getByLabel('For users')
    .fill('You can send a thank-you card.');
  await them.page.getByRole('button', { name: 'Save' }).click();
  await expect(
    them.page.getByText('Edited since asking', { exact: false }).first(),
  ).toBeVisible();
  // They can ask again for the new text.
  await expect(
    them.page.getByRole('button', { name: 'Ask again…' }),
  ).toBeVisible();
  await expectAccessible(them.page);

  await page.goto('/ops/changelog');
  await expect(entryRow(page, number)).toContainText('Edited since asking');

  await approveInApprovals(page, owner, number);
  await expect(
    page.getByRole('alert').filter({ hasText: 'This request has closed' }),
  ).toContainText('It did not run');
  expect((await published(number)).published_revision).toBeNull();
  await them.context.close();
});

test('withdrawing asks for a reason and marks the entry Withdrawn; it stays in All', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const number = await seed('feat: QR codes', { published: true, live: true });
  await page.goto(`/ops/changelog/${number}`);
  await expect(
    page.getByRole('heading', { name: 'What users read now' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Withdraw…' }).click();
  await page
    .getByLabel('Why withdraw this from users?')
    .fill('The QR change was rolled back');
  await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
  await expect(
    page.locator('.tm-slip').filter({ hasText: 'Withdrawn' }),
  ).toContainText('Users no longer see it.');
  await expect(page.getByText('The QR change was rolled back')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Withdraw…' })).toHaveCount(0);
  await expectAccessible(page);

  await page.goto('/ops/changelog');
  await expect(entryRow(page, number)).toContainText('Withdrawn');
  await page.getByRole('button', { name: 'For users' }).click();
  await expect(page).toHaveURL(/view=users$/);
  await expect(entryRow(page, number)).toHaveCount(0);
});

test('early access audience says nobody sees it until early access exists', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const number = await seed('feat: early idea', { userText: null });
  await page.goto(`/ops/changelog/${number}`);
  // No text for users: who sees it can't be chosen yet.
  const group = page.getByRole('group', { name: 'Who sees it' });
  await expect(group.getByRole('radio')).toHaveCount(3);
  for (const radio of await group.getByRole('radio').all())
    await expect(radio).toBeDisabled();
  await page.getByLabel('For users').fill('You can try the new layout early.');
  await expect(group.getByRole('radio', { name: /^Everyone/ })).toBeEnabled();
  await group.getByLabel(/^Pro pages with early access/).check();
  await expect(group).toContainText(
    'Nobody sees these until early access exists.',
  );
  await expectAccessible(page);
});
