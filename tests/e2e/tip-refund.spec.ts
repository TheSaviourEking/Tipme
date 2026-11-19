import { expect, test } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { payAtBusiness } from './business-fixtures';
import { enrolOwner, sql } from './ops-helpers';

// Owner, 14 Nov 2026: staff refund a tip from admin, and the supporter is given back the tip minus
// TipMe's fee (TipMe keeps its fee). The e2e stack seeds the tip_refunds switch on (TIP_REFUNDS, playwright.config.ts); it is off everywhere else.

test('staff see exactly what goes back and who gives it, and ask with a reason', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const recipientPage = await (await browser.newContext()).newPage();
  const who = await signUpRecipient(recipientPage, testInfo);
  await recipientPage.close();
  const { tipId } = await payAtBusiness(request, {
    handle: who.handle,
    amountMinor: '1000000',
  });
  await enrolOwner(page, testInfo);
  await page.goto('/ops/search');
  await page.getByLabel('Search').fill(tipId);
  await page.getByRole('button', { name: 'Search' }).click();
  const tips = page.getByRole('heading', { name: 'Tips' }).locator('..');
  const row = tips.getByRole('listitem').filter({ hasText: tipId });
  await row.getByRole('button', { name: 'Refund tip…' }).click();
  const panel = row.getByTestId('tip-refund');
  // A Free ₦10,000 tip: the supporter gets ₦9,500 back, TipMe keeps its ₦500 (admin writes NGN).
  await expect(panel).toContainText(
    'The supporter gets back NGN 9,500.00: the NGN 10,000.00 tip minus TipMe’s NGN 500.00 fee, which TipMe keeps.',
  );
  await expect(panel).toContainText(
    `@${who.handle} gives back NGN 9,500.00: what they received.`,
  );
  await expect(panel).not.toContainText(/bachs/i);
  await expectAccessible(page);
  await panel.getByRole('button', { name: 'Ask to refund' }).click();
  await panel
    .getByLabel('Why is this tip being refunded?')
    .fill('The supporter paid twice by mistake and asked us to refund one.');
  await panel.getByRole('button', { name: 'Ask for the refund' }).click();
  // Waiting for a second person, or (as the only staff) done alone: never silently.
  await expect(
    row
      .getByTestId('action-outcome')
      .getByText(/Waiting for a second person|Done, without a second person/),
  ).toBeVisible();
  const asked = await sql<{ n: number }>(
    `SELECT (SELECT count(*) FROM approval_requests WHERE action = 'tip.refund' AND payload->>'tipId' = $1)::int
          + (SELECT count(*) FROM tip_refunds WHERE tip_id = $1::uuid)::int AS n`,
    [tipId],
  );
  expect(asked[0]!.n).toBeGreaterThan(0);
  expect(await fitsViewport(page)).toBe(true);
});

test('the supporter’s receipt says what was refunded, and that TipMe’s fee is kept', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const recipientPage = await (await browser.newContext()).newPage();
  const who = await signUpRecipient(recipientPage, testInfo);
  await recipientPage.close();
  const { tipId, statusToken } = await payAtBusiness(request, {
    handle: who.handle,
    amountMinor: '1000000',
  });
  // The partner's confirmation is what makes it refunded; here the status answer carries it.
  await page.route(`**/v1/tips/${tipId}/status**`, async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    if (json.data?.state === 'paid')
      json.data.refund = { refundedMinor: '950000' };
    await route.fulfill({ response, json });
  });
  await page.goto(`/tip/${tipId}#t=${statusToken}`);
  const receipt = page.getByRole('region', { name: 'Your receipt' });
  await expect(receipt).toContainText('Refunded ₦9,500 (TipMe’s fee is kept)');
  await expectAccessible(page);
});
