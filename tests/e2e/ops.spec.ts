import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { enrolOwner, mismatchedTip } from './ops-helpers';

test('the owner enrols, works an issue (reveal, note, resolve) and sees it all in the audit log', async ({
  page,
  request,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const issueId = await mismatchedTip(request, 'tobi');

  await page.goto('/ops/issues');
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  const row = page.locator(`a[href="/ops/issues/${issueId}"]`);
  await expect(row).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
  await row.click();

  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Amount mismatch',
  );
  await expect(page.getByText(/@tobi/).first()).toBeVisible();
  await expect(page.getByText('Private e2e words quux')).toHaveCount(0);
  await expect(page.getByText('Kept Private')).toHaveCount(0);
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  const tag = randomUUID().slice(0, 8);
  await page.getByRole('button', { name: 'Reveal private details' }).click();
  await page
    .getByLabel('Why do you need to see them?')
    .fill(`Supporter asked about their tip ${tag}`);
  await page.getByRole('button', { name: 'Reveal', exact: true }).click();
  await expect(page.getByText('Private e2e words quux')).toBeVisible();
  await expect(page.getByText('Kept Private')).toBeVisible();

  await page.getByLabel('Add a note').fill(`Called the provider ${tag}`);
  await page.getByRole('button', { name: 'Save note' }).click();
  await expect(page.getByText(`Called the provider ${tag}`)).toBeVisible();

  await page.getByRole('button', { name: 'Resolve…' }).click();
  await page
    .getByLabel('How was it resolved?')
    .fill(`Provider confirmed nothing was taken ${tag}`);
  await page.getByRole('button', { name: 'Resolve issue' }).click();
  await expect(
    page.locator('.ops-issue__status').getByText('Resolved', { exact: true }),
  ).toBeVisible();

  await page.goto('/ops/audit');
  await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible();
  await expect(
    page.getByText(`Supporter asked about their tip ${tag}`),
  ).toBeVisible();
  await expect(
    page.getByText(`Provider confirmed nothing was taken ${tag}`),
  ).toBeVisible();
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);

  await page.goto('/ops/staff');
  await expect(page.getByText('private.view')).toBeVisible();
  await expectAccessible(page);
});

test('a recipient who is not staff sees the unavailable screen at /ops', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/ops');
  await expect(
    page.getByRole('heading', { name: 'This page isn’t available right now' }),
  ).toBeVisible();
});

test('a paused page: the owner pauses it from an issue, and the recipient sees why', async ({
  browser,
  page,
  request,
}, testInfo) => {
  const recipientContext = await browser.newContext();
  const recipient = await recipientContext.newPage();
  const { handle } = await signUpRecipient(recipient, testInfo);
  const issueId = await mismatchedTip(request, handle);

  await enrolOwner(page, testInfo);
  await page.goto(`/ops/issues/${issueId}`);
  const reason = `Reported for impersonation ${randomUUID().slice(0, 6)}`;
  await page.getByRole('button', { name: 'Pause this page…' }).click();
  await page.getByLabel('Why pause it?').fill(reason);
  await page.getByRole('button', { name: 'Pause page' }).click();
  await expect(page.getByText('Paused by TipMe')).toBeVisible();

  await recipient.goto('/dashboard');
  await expect(recipient.getByText('TipMe has paused your page')).toBeVisible();
  await expect(recipient.getByText(reason)).toBeVisible();
  await recipient.goto('/dashboard/settings');
  await expect(
    recipient.getByText(/TipMe has paused your page, so visitors/),
  ).toBeVisible();
  await expectAccessible(recipient);
  await recipientContext.close();
});
