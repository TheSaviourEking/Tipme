import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { seedBusiness } from './business-fixtures';
import { expectAccessible, fitsViewport } from './helpers';
import {
  codeFor,
  enrolOwner,
  openOpsLink,
  secondOwner,
  sql,
} from './ops-helpers';

// TipMe for businesses, PR B2: staff look a business up with its contact masked, reveal it with a
// reason, pause and restore it, and verify it with a second person.

const REASON = 'Checked the name, address and contact today';

/** The list stays mounted, hidden, after a client navigation: read only what is shown. */
const shown = (page: Page, text: string) =>
  page.getByText(text, { exact: true }).filter({ visible: true });
const section = (page: Page, name: string) =>
  page
    .locator('.settings-section')
    .filter({ has: page.getByRole('heading', { name, exact: true }) });

/** A business owner who is nobody's staff: the business's own account. */
async function ownerAccount(): Promise<string> {
  const [row] = await sql<{ id: string }>(
    `INSERT INTO users (id, email, email_verified_at) VALUES (gen_random_uuid(), $1, now()) RETURNING id`,
    [`owner.${randomUUID().slice(0, 8)}@example.com`],
  );
  return row!.id;
}

test('staff find a business with its contact hidden, reveal it with a reason, pause and restore it', async ({
  page,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const name = `Chilli ${randomUUID().slice(0, 6)}`;
  const { businessId, slug } = await seedBusiness({
    owner: await ownerAccount(),
    status: 'verified',
    name,
  });

  await openOpsLink(page, 'Businesses');
  await expect(
    page.getByRole('heading', { name: 'Businesses', level: 1 }),
  ).toBeVisible();
  await page.getByLabel('Show').selectOption({ label: 'Verified' });
  await page.getByLabel('Name or web address').fill(slug);
  const row = page.getByRole('link').filter({ hasText: name });
  await expect(row).toContainText('Verified business');
  await expect(row).toContainText('f•••@example.com');
  await expect(page.getByText('funke@example.com')).toHaveCount(0);
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  await row.click();
  await expect(page).toHaveURL(new RegExp(`/ops/businesses/${businessId}$`));
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(section(page, 'Locations')).toContainText(
    '27 Ademola Adetokunbo, Lagos',
  );
  await expect(page.getByText(/approved/i)).toHaveCount(0);
  await expectAccessible(page);

  const contact = section(page, 'Contact');
  await contact.getByRole('button', { name: 'Reveal contact' }).click();
  await contact.getByLabel('Why do you need the full contact?').fill(REASON);
  await contact.getByRole('button', { name: 'Reveal' }).click();
  await expect(contact.getByText('funke@example.com')).toBeVisible();
  await expect(contact.getByText('It is in the audit log.')).toBeVisible();

  const pause = section(page, 'Pause');
  await pause.getByRole('button', { name: 'Pause this business…' }).click();
  await pause.getByLabel('Why pause it?').fill(REASON);
  await pause.getByRole('button', { name: 'Pause this business' }).click();
  await expect(page.getByText(`${name} is paused.`)).toBeVisible();
  await expect(shown(page, 'Paused by TipMe')).toBeVisible();
  await expectAccessible(page);

  const restore = section(page, 'Restore');
  await restore.getByRole('button', { name: 'Restore this business…' }).click();
  await restore.getByLabel('Why restore it?').fill(REASON);
  await restore.getByRole('button', { name: 'Restore this business' }).click();
  await expect(page.getByText(`${name} is back.`)).toBeVisible();
  await expect(shown(page, 'Verified business')).toBeVisible();
});

test('verifying waits for a second person, who approves it; then it reads "Verified business"', async ({
  page,
  browser,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const other = await secondOwner(browser, testInfo);
  const name = `Bistro ${randomUUID().slice(0, 6)}`;
  const { businessId, slug } = await seedBusiness({
    owner: await ownerAccount(),
    status: 'pending',
    name,
  });

  await page.goto(`/ops/businesses/${businessId}`);
  await expect(shown(page, 'Waiting to be verified')).toBeVisible();
  const verify = section(page, 'Verify');
  await verify.getByRole('button', { name: 'Verify…' }).click();
  await verify.getByLabel('What did you check?').fill(REASON);
  await verify.getByRole('button', { name: 'Verify this business' }).click();
  // Asking takes the staff-admin lock and a dry run: allow for a busy machine.
  await expect(
    page.getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Its codes stay off until then.')).toBeVisible();
  await expectAccessible(page);

  await other.page.goto('/ops/approvals');
  const card = other.page
    .getByRole('article')
    .filter({ hasText: `usetipme.xyz/b/${slug}` });
  await expect(card.getByText('Verify a business')).toBeVisible();
  await card.getByRole('button', { name: 'Approve…' }).click();
  await card.getByLabel('Authenticator code').fill(await codeFor(other));
  await card.getByRole('button', { name: 'Approve and run' }).click();
  await expect(card).toHaveCount(0);
  await other.context.close();

  await page.reload();
  await expect(shown(page, 'Verified business')).toBeVisible();
  await expect(section(page, 'Verify')).toHaveCount(0);
  await expect(section(page, 'Pause')).toBeVisible();
});

test('staff who own the business can’t verify it, even alone; it stays waiting', async ({
  page,
}, testInfo) => {
  const { email } = await enrolOwner(page, testInfo);
  const [me] = await sql<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  const name = `Kitchen ${randomUUID().slice(0, 6)}`;
  const { businessId } = await seedBusiness({
    owner: me!.id,
    status: 'pending',
    name,
  });

  await page.goto(`/ops/businesses/${businessId}`);
  const verify = section(page, 'Verify');
  await verify.getByRole('button', { name: 'Verify…' }).click();
  await verify.getByLabel('What did you check?').fill(REASON);
  await verify.getByRole('button', { name: 'Verify this business' }).click();
  await expect(
    page.getByText(
      /manage this business, so you can’t verify it\. Another staff member must\./,
    ),
  ).toBeVisible({ timeout: 15_000 });
  await expectAccessible(page);
  await page.reload();
  await expect(shown(page, 'Waiting to be verified')).toBeVisible();
});
