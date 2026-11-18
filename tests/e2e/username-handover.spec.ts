import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import {
  expectAccessible,
  fitsViewport,
  identity,
  passClaimMoment,
  signInWithEmail,
} from './helpers';
import { enrolOwner, sql, withDatabase } from './ops-helpers';

// Username handover (owner's approval, 18 Nov 2026): a reserved name moves to one account, by a
// one-time claim link staff copy and send, or by staff giving it to an account they find. Names
// carry the test's own digits, so parallel projects and repeats never share one.
const REASON = 'The brand proved it owns this name';

const checkCard = (page: Page) =>
  page
    .locator('.settings-section')
    .filter({ has: page.getByRole('heading', { name: 'Check a name' }) });

async function checkName(page: Page, name: string) {
  await checkCard(page).getByLabel('Name', { exact: true }).fill(name);
  await checkCard(page).getByRole('button', { name: 'Check' }).click();
}

/** A fresh name, reserved by the signed-in owner. */
async function reservedName(email: string, prefix: string, digits: string) {
  const name = `${prefix}${digits}${randomUUID().slice(0, 4)}`;
  await withDatabase(async (db, ops) => {
    const [owner] = await sql<{ id: string }>(
      `SELECT id FROM users WHERE lower(email) = lower($1)`,
      [email],
    );
    await ops.reserveUsername(db, { staffId: owner!.id, name, reason: REASON });
  });
  return name;
}

/** A claim link made on the server, as staff would, for a name it reserves. */
async function claimLinkFor(prefix: string, digits: string) {
  const name = `${prefix}${digits}${randomUUID().slice(0, 4)}`;
  const path = await withDatabase(async (db, ops) => {
    const [staff] = await sql<{ id: string }>(
      `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
      [`staff.${name}@example.com`],
    );
    // A link works only while its maker is staff holding usernames.manage (security review).
    await sql(
      `INSERT INTO roles (id, name) VALUES ('e2e_usernames', 'e2e_usernames') ON CONFLICT DO NOTHING`,
    );
    await sql(
      `INSERT INTO role_permissions (role_id, permission) VALUES ('e2e_usernames', 'usernames.manage') ON CONFLICT DO NOTHING`,
    );
    await sql(
      `INSERT INTO staff (user_id, role_id, granted_at, enrolled_at) VALUES ($1, 'e2e_usernames', now(), now())`,
      [staff!.id],
    );
    await ops.reserveUsername(db, { staffId: staff!.id, name, reason: REASON });
    const made = await ops.createHandoverLink(db, {
      staffId: staff!.id,
      name,
      reason: REASON,
    });
    return made.path as string;
  });
  return { name, path };
}

test('staff make a claim link, see it once, and someone signs up through it @mobile', async ({
  page,
  browser,
}, testInfo) => {
  // Two people sign in by email (staff, then the claimer): longer than the default 30 s.
  test.setTimeout(90_000);
  const owner = await enrolOwner(page, testInfo);
  const digits = identity(testInfo).handle.slice(4);
  const name = await reservedName(owner.email, 'brand', digits);
  await page.goto('/ops/usernames');
  await checkName(page, name);
  await expect(checkCard(page).getByText('Reserved.')).toBeVisible();
  await expect(checkCard(page).getByText('No claim link.')).toBeVisible();
  await expect(
    checkCard(page).getByRole('button', { name: 'Give to an account…' }),
  ).toBeVisible();

  await checkCard(page)
    .getByRole('button', { name: 'Create claim link…' })
    .click();
  await checkCard(page).getByLabel('Why make a claim link?').fill(REASON);
  await checkCard(page)
    .getByRole('button', { name: 'Create claim link', exact: true })
    .click();
  await expect(checkCard(page).getByText('Copy this link now')).toBeVisible();
  const field = checkCard(page).getByLabel(`Claim link for @${name}`);
  const link = await field.inputValue();
  expect(link).toMatch(/\/sign-up\/claim#claim=[A-Z2-7]{24}$/);
  const code = link.split('#claim=')[1]!;
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  // Shown once: a fresh look at the name shows the open link, never the code again.
  await page.reload();
  await checkName(page, name);
  await expect(checkCard(page).getByText(/^Open until /)).toBeVisible();
  await expect(
    checkCard(page).getByLabel(`Claim link for @${name}`),
  ).toHaveCount(0);
  expect(await page.content()).not.toContain(code);

  // Someone new opens it, signs up with their email, and claims the name.
  const theirs = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    viewport: testInfo.project.use.viewport ?? undefined,
  });
  const them = await theirs.newPage();
  await them.goto(link);
  await expect(
    them.getByRole('heading', { name: `@${name} is waiting for you.` }),
  ).toBeVisible();
  // The code left the address bar at once.
  await expect.poll(() => new URL(them.url()).hash).toBe('');
  await expectAccessible(them);
  expect(await fitsViewport(them)).toBe(true);
  const { email } = identity({ ...testInfo, workerIndex: 7 });
  await signInWithEmail(them, `claim.${email}`, null);
  await expect(
    them.getByRole('heading', { name: `Claim @${name}` }),
  ).toBeVisible();
  await expect(them.getByText(`Your page will be at /@${name}.`)).toBeVisible();
  await them.getByRole('button', { name: `Claim @${name}` }).click();
  await them.waitForURL(/\/dashboard\/welcome$/);
  await passClaimMoment(them, name);

  // Used: the link now says so, and staff see a page holding the name.
  await them.goto(link);
  await expect(
    them.getByRole('heading', { name: 'This link has been used' }),
  ).toBeVisible();
  await theirs.close();
  await checkName(page, name);
  await expect(checkCard(page).getByText(/’s username\./)).toBeVisible();
});

test('an expired, cancelled or unknown claim link says so plainly @mobile', async ({
  page,
}, testInfo) => {
  const digits = identity(testInfo).handle.slice(4);
  const expired = await claimLinkFor('late', digits);
  await sql(
    `UPDATE handle_handover_links SET created_at = now() - interval '15 days', expires_at = now() - interval '1 day' WHERE handle_lower = $1`,
    [expired.name],
  );
  await page.goto(expired.path);
  await expect(
    page.getByRole('heading', { name: 'This link has expired' }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toContainText('14 days');
  await expect(page.getByRole('main')).not.toContainText(expired.name);
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  const cancelled = await claimLinkFor('stop', digits);
  await sql(
    `UPDATE handle_reservations SET released_at = now(), released_by = reserved_by, release_reason = 'Not needed any more' WHERE handle_lower = $1`,
    [cancelled.name],
  );
  await page.goto(cancelled.path);
  await expect(
    page.getByRole('heading', { name: 'This link no longer works' }),
  ).toBeVisible();

  await page.goto('/sign-up/claim#claim=NOTACODE');
  await expect(
    page.getByRole('heading', { name: 'We don’t recognise this link' }),
  ).toBeVisible();
});

test('someone with a page claims through the link; their old username keeps leading there', async ({
  page,
}, testInfo) => {
  const digits = identity(testInfo).handle.slice(4);
  const { name, path } = await claimLinkFor('swap', digits);
  const who = identity(testInfo);
  const old = `old${digits}${randomUUID().slice(0, 4)}`;
  await signInWithEmail(page, who.email, '/sign-up');
  await page.getByLabel('Username').fill(old);
  await page.getByRole('button', { name: `Claim @${old}` }).click();
  await page.waitForURL(/\/dashboard\/welcome$/);
  await passClaimMoment(page, old);
  await sql(`UPDATE profiles SET page_state = 'live' WHERE handle_lower = $1`, [
    old,
  ]);

  await page.goto(path);
  await expect(
    page.getByRole('heading', { name: `Claim @${name}` }),
  ).toBeVisible();
  await expect(
    page.getByText(`Your username changes from @${old} to @${name}.`),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: `Claim @${name}` }).click();
  await expect(
    page.getByRole('heading', { name: `@${name} is yours.` }),
  ).toBeVisible();
  await expect(page.getByRole('main')).toContainText(
    `Links and QR codes with @${old} keep leading to it.`,
  );
  await page.goto(`/@${old}`);
  await expect(page).toHaveURL(new RegExp(`/@${name}$`));
});

test('staff give a reserved name to an account found by email, with no email shown', async ({
  page,
}, testInfo) => {
  const owner = await enrolOwner(page, testInfo);
  const digits = identity(testInfo).handle.slice(4);
  const name = await reservedName(owner.email, 'give', digits);
  const old = `kemi${digits}${randomUUID().slice(0, 4)}`;
  const theirEmail = `give.${old}@example.com`;
  await sql(
    `WITH u AS (INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id)
     INSERT INTO profiles (id, user_id, handle, handle_lower, display_name, page_state)
     SELECT gen_random_uuid(), u.id, $2, $2, 'Kemi Adé', 'live' FROM u`,
    [theirEmail, old],
  );
  await page.goto('/ops/usernames');
  await checkName(page, name);
  await checkCard(page)
    .getByRole('button', { name: 'Give to an account…' })
    .click();
  await checkCard(page)
    .getByLabel('Their username or email')
    .fill(theirEmail.toUpperCase());
  await checkCard(page).getByRole('button', { name: 'Find' }).click();
  await expect(
    checkCard(page).getByText(`@${old}, Kemi Adé, Free, live`),
  ).toBeVisible();
  await expect(checkCard(page)).not.toContainText('example.com');
  await expect(
    checkCard(page).getByText(`@${old}’s username becomes @${name}.`, {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    checkCard(page).getByText('We email them to say so, without your reason.', {
      exact: false,
    }),
  ).toBeVisible();
  await expectAccessible(page);
  await checkCard(page)
    .getByLabel(`Why give @${name} to this account?`)
    .fill('Their brand team asked by email today');
  await checkCard(page)
    .getByRole('button', { name: `Give @${name} to @${old}` })
    .click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Given' }),
  ).toContainText(`@${old} keeps leading to their page.`);
  await expect(checkCard(page).getByText(`@${name}’s username.`)).toBeVisible();
  await page.goto(`/@${old}`);
  await expect(page).toHaveURL(new RegExp(`/@${name}$`));
});

// Security review of PR #280: no active staff account receives a handed-over name.
test('a staff account found for a handover says so, and Give is not offered', async ({
  page,
}, testInfo) => {
  const owner = await enrolOwner(page, testInfo);
  const digits = identity(testInfo).handle.slice(4);
  const name = await reservedName(owner.email, 'staffno', digits);
  await page.goto('/ops/usernames');
  await checkName(page, name);
  await checkCard(page)
    .getByRole('button', { name: 'Give to an account…' })
    .click();
  // The owner's own account: staff.
  await checkCard(page).getByLabel('Their username or email').fill(owner.email);
  await checkCard(page).getByRole('button', { name: 'Find' }).click();
  await expect(
    checkCard(page).getByText(
      'Staff accounts can’t receive a username this way.',
    ),
  ).toBeVisible();
  await expect(
    checkCard(page).getByRole('button', { name: new RegExp(`^Give @${name}`) }),
  ).toHaveCount(0);
  await expectAccessible(page);
});
