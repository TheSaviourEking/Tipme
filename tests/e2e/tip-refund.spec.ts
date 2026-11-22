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

// You collect (plan Task 10): a collect tip is refunded from TipMe's own balance once the
// recipient's part is back. When they have already withdrawn part of it, staff see the gap, the
// plain refund is not offered, and going ahead is a second person's decision. The API's answers
// for a withdrawn collect tip are held here (the integration tests cover the API itself:
// tip-refund-api.test.mjs and collect-refunds.test.mjs).
test('staff see the gap and the second-person step on a withdrawn collect tip', async ({
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
  const refundPath = `**/v1/ops/tips/${tipId}/refund`;
  await page.route(refundPath, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      json: {
        data: {
          tipId,
          refundable: true,
          refusal: null,
          words: 'This tip can be refunded. TipMe keeps its fee.',
          handle: who.handle,
          businessName: null,
          currency: 'NGN',
          grossMinor: '1000000',
          feeMinor: '50000',
          refundMinor: '950000',
          personMinor: '950000',
          businessMinor: '0',
          refund: null,
          collect: { plan: 'staff_decides', gapMinor: '650000' },
          lastFailure: null,
        },
      },
    });
  });
  let asked: { reason?: string } | null = null;
  await page.route(`${refundPath}/absorb-gap`, async (route) => {
    asked = route.request().postDataJSON() as { reason?: string };
    await route.fulfill({
      status: 202,
      json: { data: { requestId: '00000000-0000-4000-8000-000000000001' } },
    });
  });
  await enrolOwner(page, testInfo);
  await page.goto('/ops/search');
  await page.getByLabel('Search').fill(tipId);
  await page.getByRole('button', { name: 'Search' }).click();
  const tips = page.getByRole('heading', { name: 'Tips' }).locator('..');
  const row = tips.getByRole('listitem').filter({ hasText: tipId });
  await row.getByRole('button', { name: 'Refund tip…' }).click();
  const panel = row.getByTestId('tip-refund');
  await expect(panel).toContainText(
    'The supporter gets back NGN 9,500.00: the NGN 10,000.00 tip minus TipMe’s NGN 500.00 fee, which TipMe keeps.',
  );
  await expect(panel).toContainText('Part of this tip can’t be taken back');
  await expect(panel).toContainText(
    'Up to NGN 6,500.00 is no longer there to take back: the recipient (or the business) has already withdrawn it. TipMe would pay that from its own balance as a loss.',
  );
  // The plain refund isn't offered: only the step a second person decides.
  await expect(
    panel.getByRole('button', { name: 'Ask to refund' }),
  ).toHaveCount(0);
  await expect(panel).not.toContainText(/bachs/i);
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
  await testInfo.attach('gap', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await panel
    .getByRole('button', { name: 'Refund and absorb the gap' })
    .click();
  await panel
    .getByLabel('Why should TipMe refund this and absorb the gap?')
    .fill('The supporter was charged twice; the recipient already withdrew.');
  await testInfo.attach('reason', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  await panel.getByRole('button', { name: 'Ask a second person' }).click();
  await expect(
    row.getByTestId('action-outcome').getByText(/Waiting for a second person/),
  ).toBeVisible();
  expect(asked).toEqual({
    reason: 'The supporter was charged twice; the recipient already withdrew.',
  });
  await testInfo.attach('waiting', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
});

// Task 15 follow-up (Task 11): a failed refund of a collect tip pulled money back from the business
// as well as from the recipient. Staff see both beside each other, and the return sends both back
// (`tip_refund.return`, a second person). The API's answers are held here; tip-refund-api.test.mjs
// and collect-refunds.test.mjs cover the API.
test('staff see money held back from the business beside the recipient’s, and return both', async ({
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
  const refundPath = `**/v1/ops/tips/${tipId}/refund`;
  await page.route(refundPath, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    await route.fulfill({
      json: {
        data: {
          tipId,
          refundable: false,
          refusal: 'already',
          words:
            'This tip already has a refund in progress or paid, or it was already taken back (a refund or chargeback).',
          handle: who.handle,
          businessName: 'Mama Put Kitchen',
          currency: 'NGN',
          grossMinor: '1000000',
          feeMinor: '50000',
          refundMinor: '950000',
          personMinor: '665000',
          businessMinor: '285000',
          refund: null,
          collect: { plan: 'take_back', gapMinor: '0' },
          lastFailure: 'TipMe’s balance can’t cover this refund right now.',
          heldMinor: '665000',
          businessHeldMinor: '285000',
          unbookedMinor: '0',
        },
      },
    });
  });
  let asked: { reason?: string } | null = null;
  await page.route(`${refundPath}/return`, async (route) => {
    asked = route.request().postDataJSON() as { reason?: string };
    await route.fulfill({
      status: 202,
      json: { data: { requestId: '00000000-0000-4000-8000-000000000002' } },
    });
  });
  await enrolOwner(page, testInfo);
  await page.goto('/ops/search');
  await page.getByLabel('Search').fill(tipId);
  await page.getByRole('button', { name: 'Search' }).click();
  const tips = page.getByRole('heading', { name: 'Tips' }).locator('..');
  const row = tips.getByRole('listitem').filter({ hasText: tipId });
  await row.getByRole('button', { name: 'Refund tip…' }).click();
  const panel = row.getByTestId('tip-refund');
  const held = panel.getByTestId('refund-held');
  await expect(held).toContainText('NGN 6,650.00');
  await expect(held).toContainText(`@${who.handle}`);
  await expect(held).toContainText('NGN 2,850.00');
  await expect(held).toContainText('Mama Put Kitchen');
  await expect(panel).not.toContainText(/bachs/i);
  await expectAccessible(page);
  expect(await fitsViewport(page)).toBe(true);
  // The skip link shows only on keyboard focus; for the picture it stays out of the way.
  await page.addStyleTag({
    content: '.skip-link { visibility: hidden !important; }',
  });
  for (const [label, width] of [
    ['phone', 390],
    ['desktop', 1440],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await held.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath(`${label}-business-held.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  await panel
    .getByRole('button', { name: 'Return to recipient and business' })
    .click();
  await panel
    .getByLabel('Why is this money going back?')
    .fill('The refund failed; the supporter will be refunded another way.');
  await panel.getByRole('button', { name: 'Ask a second person' }).click();
  await expect(
    row.getByTestId('action-outcome').getByText(/Waiting for a second person/),
  ).toBeVisible();
  expect(asked).toEqual({
    reason: 'The refund failed; the supporter will be refunded another way.',
  });
});
