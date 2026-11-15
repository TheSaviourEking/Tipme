import { randomUUID } from 'node:crypto';
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { payAtBusiness } from './business-fixtures';
import { enrolOwner, sql, withDatabase } from './ops-helpers';

// Taking back a refunded or charged-back tip from its issue (`tip.reverse`, 16 Nov 2026). The tip
// is paid with the pretend provider; the partner's refund or dispute report is recorded through the
// database operation its webhook uses. Nothing reaches a real payment API.

const SHOTS = process.env.STAFF_TOOLS_SHOTS;

async function shoot(page: Page, name: string) {
  if (!SHOTS) return;
  const size = page.viewportSize();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({
      path: `${SHOTS}/${name}-${width}.png`,
      fullPage: true,
    });
  }
  if (size) await page.setViewportSize(size);
}

/** A paid ₦10,000 Free tip, and the issue our payment partner's report of a refund or dispute opened. */
async function reportedReversal(
  request: APIRequestContext,
  handle: string,
  report: {
    partnerReversalId: string;
    refundState: 'pending' | 'paid' | null;
    refundedMinor?: bigint;
  },
) {
  const { tipId } = await payAtBusiness(request, {
    handle,
    amountMinor: '1000000',
  });
  const [found] = await sql<{ attemptId: string }>(
    `SELECT a.id AS "attemptId" FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
      WHERE t.id = $1`,
    [tipId],
  );
  const attemptId = found!.attemptId;
  await withDatabase((db, ops) =>
    ops.flagPaymentReversal(db, {
      attemptId,
      eventId: `evt_${randomUUID()}`,
      eventType: report.partnerReversalId.startsWith('dispute.')
        ? 'charge.dispute.created'
        : `refund.${report.refundState}`,
      partnerReversalId: report.partnerReversalId,
      disputeWon: false,
      refundState: report.refundState,
      refundedMinor: report.refundedMinor ?? null,
      refundFeeMinor: report.refundedMinor ? 0n : null,
    }),
  );
  const [issue] = await sql<{ id: string }>(
    `SELECT id FROM issues WHERE kind = 'payment_reversed' AND subject->>'partnerReversalId' = $1`,
    [report.partnerReversalId],
  );
  return { tipId, issueId: issue!.id };
}

test('a paid refund: staff read what the books will record, then take the tip back with a reason', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const recipient = await (await browser.newContext()).newPage();
  const who = await signUpRecipient(recipient, testInfo);
  await recipient.close();
  const partnerReversalId = `refund.re_${randomUUID().replaceAll('-', '')}`;
  const { issueId } = await reportedReversal(request, who.handle, {
    partnerReversalId,
    refundState: 'paid',
    // The tip minus TipMe's 7% (owner, 14 Nov 2026: a refund keeps TipMe's fee).
    refundedMinor: 930000n,
  });
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/issues/${issueId}`);
  const section = page.getByRole('region', { name: 'Take back this tip' });
  const panel = section.getByTestId('tip-reverse');
  await expect(panel).toContainText(
    'Our payment partner gave the supporter back NGN 9,300.00.',
  );
  await expect(panel).toContainText(`@${who.handle} gives back their part`);
  await expect(panel).toContainText('TipMe keeps its fee on a refund.');
  await expect(panel).toContainText('Nothing moves at our payment partner');
  await expect(panel).toContainText(
    'withdrawals wait until it is back above zero',
  );
  await expect(panel).not.toContainText(/bachs/i);
  await panel.getByRole('button', { name: 'Take back this tip…' }).click();
  await expect(panel).toContainText('Amount: NGN 9,300.00');
  // The dashboard check is asked for, not assumed.
  await panel
    .getByLabel('Why take this tip back?')
    .fill('Checked the refund in the partner dashboard: paid in full today.');
  await panel.getByRole('button', { name: 'Take back the tip' }).click();
  await expect(panel.getByText('Confirm you checked this')).toBeVisible();
  await panel
    .getByLabel('I checked this refund in our payment partner’s dashboard.')
    .check();
  await expectAccessible(page);
  await shoot(page, 'tip-reverse-refund');
  await panel.getByRole('button', { name: 'Take back the tip' }).click();
  // Waiting for a second person, or (as the only staff) done alone: never silently.
  await expect(
    page
      .getByTestId('action-outcome')
      .getByText(/Waiting for a second person|Done, without a second person/),
  ).toBeVisible();
  const [asked] = await sql<{ n: number }>(
    `SELECT (SELECT count(*) FROM approval_requests WHERE action = 'tip.reverse' AND payload->>'issueId' = $1)::int
          + (SELECT count(*) FROM ledger_transactions WHERE operation_key = $2)::int AS n`,
    [issueId, `reversal.${partnerReversalId}`],
  );
  expect(asked!.n).toBeGreaterThan(0);
  expect(await fitsViewport(page)).toBe(true);
});

test('@mobile a refund not paid yet says so with no button; a chargeback asks for its amount', async ({
  page,
  browser,
  request,
}, testInfo) => {
  const recipient = await (await browser.newContext()).newPage();
  const who = await signUpRecipient(recipient, testInfo);
  await recipient.close();
  const pending = await reportedReversal(request, who.handle, {
    partnerReversalId: `refund.re_${randomUUID().replaceAll('-', '')}`,
    refundState: 'pending',
  });
  const dispute = await reportedReversal(request, who.handle, {
    partnerReversalId: `dispute.dp_${randomUUID().replaceAll('-', '')}`,
    refundState: null,
  });
  await enrolOwner(page, testInfo);
  await page.goto(`/ops/issues/${pending.issueId}`);
  const section = page.getByRole('region', { name: 'Take back this tip' });
  await expect(section.getByTestId('tip-reverse-wait')).toContainText(
    'hasn’t said this refund is paid yet',
  );
  await expect(section.getByRole('button', { name: /Take back/ })).toHaveCount(
    0,
  );
  await expectAccessible(page);

  await page.goto(`/ops/issues/${dispute.issueId}`);
  const panel = page
    .getByRole('region', { name: 'Take back this tip' })
    .getByTestId('tip-reverse');
  await expect(panel).toContainText('A chargeback');
  await expect(panel).toContainText('TipMe bears its own fee.');
  await panel.getByRole('button', { name: 'Take back this tip…' }).click();
  await expect(panel.getByLabel('Amount charged back (NGN)')).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
  await expectAccessible(page);
  await shoot(page, 'tip-reverse-dispute');
});
