import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner } from './ops-helpers';

// You collect staff screens (plan Task 15, spec §9). The API's answers for held money, transfers and
// disputes are held here with page.route: a collect tip needs the partner, and the integration suite
// (collect-ops-api.test.mjs) covers the API, its masking and every money action. The People list's
// collection mode is real. The reserve screen comes with Task 11, so it is not linked here.

const fits = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

/** Screenshots for the PR body, only when asked (PR_SHOTS=<dir>). */
async function shot(page: Page, name: string) {
  const dir = process.env['PR_SHOTS'];
  if (!dir) return;
  for (const [label, width] of [
    ['phone', 390],
    ['desktop', 1440],
  ] as const) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.waitForTimeout(150);
    await page.screenshot({
      path: `${dir}/${name}-${label}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

test('staff see held money, a transfer in review, a dispute with its deadline, and the collection mode', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const recipientPage = await (await browser.newContext()).newPage();
  const who = await signUpRecipient(recipientPage, testInfo);
  await recipientPage.close();
  const handle = who.handle;
  const profileId = randomUUID();
  const transferId = randomUUID();
  const disputeId = randomUUID();
  const tipId = randomUUID();
  const respondBy = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const now = new Date().toISOString();
  const transfer = {
    id: transferId,
    kind: 'share',
    status: 'review',
    reviewReason: 'provider',
    handle,
    amountMinor: '950000',
    currency: 'NGN',
    group: `tipme-collect-${tipId}`,
    bankLast4: '1234',
    attempts: 2,
    refused: false,
    sentAt: now,
    createdAt: now,
    updatedAt: now,
  };
  const dispute = {
    id: disputeId,
    handle,
    amountMinor: '950000',
    currency: 'NGN',
    status: 'open',
    reason: 'fraudulent',
    respondBy,
    evidenceState: 'none',
    heldMinor: '950000',
    settledAt: null,
    createdAt: now,
  };
  const asked: string[] = [];
  await page.route('**/v1/ops/collect/**', async (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    if (method === 'POST') {
      asked.push(path);
      return route.fulfill({
        status: 202,
        json: { data: { requestId: randomUUID() } },
      });
    }
    if (path.endsWith('/collect/held'))
      return route.fulfill({
        json: {
          data: {
            totals: [{ currency: 'NGN', heldMinor: '1900000' }],
            recipients: [
              {
                profileId,
                handle,
                heldMinor: '1900000',
                currency: 'NGN',
                verified: false,
                oldestTipAt: now,
                daysLeft: 23,
                remindersSent: 1,
                paused: false,
                pausedReason: null,
              },
            ],
            businesses: [],
          },
        },
      });
    if (path.endsWith('/collect/transfers'))
      return route.fulfill({ json: { data: [transfer] } });
    if (path.endsWith('/collect/same-bank'))
      return route.fulfill({
        json: {
          data: [
            {
              profileId,
              handle,
              openIssues: 1,
              heldTransfers: 1,
              heldMinor: '950000',
              since: now,
            },
          ],
        },
      });
    if (path.endsWith('/collect/disputes'))
      return route.fulfill({ json: { data: [dispute] } });
    if (path.endsWith(`/collect/disputes/${disputeId}`))
      return route.fulfill({
        json: {
          data: {
            ...dispute,
            partnerDisputeId: 'dsp_e2e_1',
            shareStep: 'balance',
            decidedAt: null,
            feeMinor: null,
            feeCurrency: null,
            evidence: {
              state: 'none',
              files: [],
              askedAt: null,
              submittedAt: null,
              canSubmit: true,
              late: false,
            },
            holdRelease: {
              possible: false,
              why: 'Only a dispute closed without a ruling keeps its hold for a refund.',
            },
          },
        },
      });
    if (path.endsWith('/collect/unclaimed'))
      return route.fulfill({ json: { data: [] } });
    return route.fallback();
  });

  await enrolOwner(page, testInfo);
  await page.goto('/ops/collect');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('heading', { name: 'You collect', level: 1 }),
  ).toBeVisible();
  const overview = main.getByTestId('collect-overview');
  await expect(overview).toContainText('₦19,000');
  await expect(overview).toContainText('Transfers in review');
  await expect(
    page.getByRole('navigation', { name: 'You collect' }).getByRole('link'),
  ).toHaveText([
    'Overview',
    'Held money',
    'Transfers',
    'Disputes',
    'Unclaimed',
    'Settings',
  ]);
  await expectAccessible(page);
  await shot(page, 'collect-overview');

  // Held money: the ledger's total, then the recipient, the days left and reminders.
  await page
    .getByRole('navigation', { name: 'You collect' })
    .getByRole('link', { name: 'Held money' })
    .click();
  await expect(main.getByTestId('held-totals')).toContainText('₦19,000');
  const table = main.getByRole('table', { name: 'Money held per recipient' });
  const row = table.getByRole('row').filter({ hasText: `@${handle}` });
  await expect(row).toContainText('₦19,000');
  await expect(row).toContainText('23 days');
  await expect(row).toContainText('Taking tips');
  await expectAccessible(page);
  await shot(page, 'collect-held');

  // A transfer in review, with its group and bank's last four digits only; retry waits for a second person.
  await page.goto('/ops/collect/transfers');
  const item = main
    .getByRole('list', { name: 'Collect transfers' })
    .getByTestId('collect-transfer')
    .filter({ hasText: `@${handle}` });
  await expect(item).toContainText('In review');
  await expect(item).toContainText(`tipme-collect-${tipId}`);
  await expect(item).toContainText('bank ending 1234');
  await expect(
    main.getByRole('list', { name: 'Shared bank account holds' }),
  ).toContainText(`@${handle}`);
  await expectAccessible(page);
  await shot(page, 'collect-transfers');
  await item.getByRole('button', { name: 'Retry…' }).click();
  await item
    .getByLabel('What you checked in the partner dashboard for its group')
    .fill('Nothing in the dashboard under this group; safe to send again.');
  await shot(page, 'collect-retry-dialog');
  await item.getByRole('button', { name: 'Ask to retry' }).click();
  await expect(
    item
      .getByTestId('action-outcome')
      .getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible();
  expect(asked).toContain(`/v1/ops/collect/transfers/${transferId}/retry`);
  await item.getByRole('button', { name: 'Record as paid…' }).click();
  await expect(
    item.getByLabel('What the partner dashboard shows for its group'),
  ).toBeVisible();
  await shot(page, 'collect-record-paid-dialog');

  // A dispute with its deadline, and the evidence state from TipMe's records.
  await page.goto('/ops/collect/disputes');
  const link = main
    .getByRole('list', { name: 'Disputes' })
    .getByRole('link')
    .filter({ hasText: `@${handle}` });
  await expect(link).toContainText('Answer by');
  await expect(link).toContainText('Evidence: Not started');
  await shot(page, 'collect-disputes');
  await link.click();
  await page.waitForURL(`**/ops/collect/disputes/${disputeId}`);
  const facts = main.getByTestId('dispute-facts');
  await expect(facts).toContainText('Open');
  await expect(facts).toContainText('Answer by');
  await expect(main.getByTestId('evidence-state')).toHaveText('Not started');
  await main
    .getByLabel('Evidence for the payment partner')
    .fill(
      'The supporter tipped at the venue in person and was given a receipt.',
    );
  await main
    .getByLabel('Reason for sending it')
    .fill('Checked the venue records for this tip');
  await expectAccessible(page);
  await shot(page, 'collect-dispute-evidence');
  await main.getByRole('button', { name: 'Ask to submit' }).click();
  await expect(
    main
      .getByTestId('action-outcome')
      .getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible();
  expect(asked).toContain(`/v1/ops/collect/disputes/${disputeId}/evidence`);

  await page.goto('/ops/collect/unclaimed');
  await expect(
    main.getByRole('heading', { name: 'Nobody past the cap' }),
  ).toBeVisible();
  await shot(page, 'collect-unclaimed');

  // The settings screen reads the real settings API (Task 12).
  await page.goto('/ops/collect/settings');
  await expect(main.getByTestId('collect-paused')).toContainText(
    'Transfers to recipients are running.',
  );
  await expect(main.getByLabel('Holding cap (₦)')).toHaveValue('50000');
  await expectAccessible(page);
  await shot(page, 'collect-settings');

  // At phone width every screen fits, with no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of [
    '/ops/collect',
    '/ops/collect/held',
    '/ops/collect/transfers',
  ])
    await page.goto(path).then(async () => {
      await expect(main.getByRole('heading', { level: 1 })).toBeVisible();
      expect(await fits(page)).toBe(true);
    });
  await page.setViewportSize({ width: 1280, height: 720 });

  // People: the new recipient's page, read-only, is collected by their account.
  await page.unroute('**/v1/ops/collect/**');
  await page.goto(`/ops/users?q=${handle}`);
  await expect(
    main
      .getByRole('row')
      .filter({ hasText: `@${handle}` })
      .getByTestId('collection-mode'),
  ).toHaveText('Account collects');
  await shot(page, 'people-collection-mode');
});
