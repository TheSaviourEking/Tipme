import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import {
  accountOf,
  seedAgreement,
  seedBusiness,
  seedMember,
} from './business-fixtures';
import { expectAccessible, signUpRecipient, tipAsVisitor } from './helpers';
import {
  codeFor,
  enrolOwner,
  secondOwner,
  sql,
  withDatabase,
  type TestInfo,
} from './ops-helpers';
import { shoot } from './split-shots';
import { API_ORIGIN } from './stack';

// Fee waivers (spec 2026-11-23 §7, W16, W17): what a recipient sees while TipMe pays their fees,
// and after. Account-scope rules only, each on a fresh account: a kind-wide rule would change every
// parallel test's fees. "The end date passed" is a later row of the same key that has already
// ended, inserted (W16): a rule row is never edited.

const DAY_MS = 86_400_000;
const PROVIDER_NAMES = /bachs|mock/i;

const domain = () => import('../../packages/domain/dist/index.js');

/** The Lagos date `days` from now (YYYY-MM-DD), and how the screens word its end. */
async function lagosDateIn(days: number) {
  const { endOfLagosDayIso, lagosDateOf, untilWords, untilWordsWithYear } =
    await domain();
  const date: string = lagosDateOf(new Date(Date.now() + days * DAY_MS));
  const endsAt: string = endOfLagosDayIso(date);
  return {
    date,
    until: untilWords(new Date(endsAt), new Date()) as string,
    untilWithYear: untilWordsWithYear(new Date(endsAt)) as string,
  };
}

/** Each key's waiver ends now: a later row of the same key, already over (W2, W16). */
async function endWaivers(
  owner: { profileId: string } | { businessId: string },
  fees: ('tip' | 'withdrawal')[],
) {
  const [column, id] =
    'profileId' in owner
      ? ['profile_id', owner.profileId]
      : ['business_id', owner.businessId];
  const kind = 'profileId' in owner ? 'individual' : 'business';
  for (const fee of fees)
    await sql(
      `INSERT INTO fee_waivers (id, scope, kind, profile_id, business_id, fee, payer, starts_at,
         ends_at, reason, set_by, approved_by, created_at)
       SELECT gen_random_uuid(), 'account', $2, $3::uuid, $4::uuid, $5, 'tipme',
              max(starts_at) + interval '1 millisecond',
              max(starts_at) + interval '2 milliseconds',
              'E2E: the end date has passed', NULL, NULL, clock_timestamp()
         FROM fee_waivers
        WHERE scope = 'account' AND fee = $5 AND ${column} = $1::uuid`,
      [
        id,
        kind,
        column === 'profile_id' ? id : null,
        column === 'business_id' ? id : null,
        fee,
      ],
    );
}

/** The recipient's newest paid tip, once it is in. */
async function newestTipId(profileId: string, after: string | null) {
  let id = '';
  await expect(async () => {
    const [row] = await sql<{ id: string }>(
      `SELECT id FROM tips WHERE profile_id = $1 AND status = 'SUCCEEDED'
        ORDER BY completed_at DESC LIMIT 1`,
      [profileId],
    );
    expect(row?.id ?? null).not.toBeNull();
    expect(row!.id).not.toBe(after);
    id = row!.id;
  }).toPass({ timeout: 20_000 });
  return id;
}

/** A recipient signed up in a context of its own, kept open for the test (closed by the caller). */
async function newRecipient(browser: Browser, testInfo: TestInfo & Shots) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const who = await signUpRecipient(page, testInfo);
  const [profile] = await sql<{ id: string }>(
    'SELECT id FROM profiles WHERE handle = $1',
    [who.handle],
  );
  return { context, page, ...who, profileId: profile!.id };
}
type Shots = { project: { use: { baseURL?: string } } };

async function askForAccountWaiver(
  staff: Page,
  handle: string,
  fee: 'tip' | 'withdrawal',
  lastDay: string,
) {
  await staff.goto('/ops/pages');
  const main = staff.getByRole('main');
  await main.getByLabel('Username').fill(handle);
  await main.getByRole('button', { name: 'Find page' }).click();
  const card = main.getByRole('region', { name: 'Who pays the fees' });
  await card.getByRole('button', { name: `Change the ${fee} fee…` }).click();
  const form = card.locator('form');
  await form.getByRole('radio', { name: /TipMe pays/ }).check();
  await form.getByLabel('Last day (optional)').fill(lastDay);
  await form
    .getByLabel('Reason')
    .fill(`Launch partner, TipMe covers the ${fee} fee`);
  await form.getByRole('button', { name: 'Ask for approval' }).click();
  await expect(
    card.getByText('Waiting for a second person', { exact: true }),
  ).toBeVisible({ timeout: 15_000 });
}

async function approve(
  second: Awaited<ReturnType<typeof secondOwner>>,
  text: string,
) {
  await second.page.goto('/ops/approvals');
  const request = second.page.getByRole('article').filter({ hasText: text });
  // The list loads after the page; give it the time a busy stack takes.
  await expect(request).toBeVisible({ timeout: 15_000 });
  await request.getByRole('button', { name: 'Approve…' }).click();
  await request.getByLabel('Authenticator code').fill(await codeFor(second));
  await request.getByRole('button', { name: 'Approve and run' }).click();
  await expect(request).toHaveCount(0);
}

async function openDashboard(page: Page) {
  await page.goto('/dashboard');
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 }).first()).toBeVisible({
    timeout: 15_000,
  });
  return main;
}

async function openTip(page: Page, tipId: string) {
  await page.goto(`/dashboard/tips/${tipId}`);
  const receipt = page.getByRole('main').locator('.receipt');
  // The receipt loads after the page; give it the time a busy stack takes.
  await expect(receipt.getByText('You received')).toBeVisible({
    timeout: 15_000,
  });
  return receipt;
}

/** The withdraw screen with the whole balance chosen, once the balance can be withdrawn. */
async function chooseEverything(page: Page) {
  await expect(async () => {
    await page.goto('/dashboard/withdraw');
    await expect(page.getByRole('button', { name: 'Everything' })).toBeEnabled({
      timeout: 2000,
    });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Everything' }).click();
  return page.getByRole('region', { name: 'Summary' });
}

// @alone: a second person approves a money change, as ops-fee-waivers.spec.ts does.
test('@alone staff set a tip and a withdrawal waiver; a second person approves; the recipient sees it, then sees it end', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(240_000);
  const recipient = await newRecipient(browser, testInfo);
  const second = await secondOwner(browser, testInfo);
  try {
    const { handle, profileId } = recipient;
    const me = recipient.page;
    const end = await lagosDateIn(40);

    // Today's rules: no line yet.
    let main = await openDashboard(me);
    await expect(main.getByTestId('tip-fee-waiver')).toHaveCount(0);

    // Staff ask for both waivers on this one page; a second person approves each.
    await enrolOwner(page, testInfo);
    await askForAccountWaiver(page, handle, 'tip', end.date);
    await askForAccountWaiver(page, handle, 'withdrawal', end.date);
    await approve(
      second,
      `TipMe pays the tip fee for @${handle} ${end.untilWithYear}`,
    );
    await approve(
      second,
      `TipMe pays the withdrawal fee for @${handle} ${end.untilWithYear}`,
    );

    // The dashboard says TipMe covers the fee on their tips, until the day picked.
    main = await openDashboard(me);
    await expect(main.getByTestId('tip-fee-waiver')).toHaveText(
      `TipMe is covering the fee on your tips ${end.until}`,
    );
    await expect(main).not.toContainText(PROVIDER_NAMES);
    await expectAccessible(me);
    await shoot(me, 't10-dashboard-line', async () => {
      await expect(main.getByTestId('tip-fee-waiver')).toBeVisible();
    });

    // A visitor tips ₦2,000: the fee is ₦0, and the tip says TipMe covered it.
    await tipAsVisitor(browser, handle);
    const waivedTip = await newestTipId(profileId, null);
    let receipt = await openTip(me, waivedTip);
    const feeRow = receipt.locator('.rrow').nth(1);
    await expect(feeRow.locator('dt')).toContainText('TipMe fee (waived)');
    await expect(feeRow.locator('dd')).toHaveText('−₦0');
    await expect(receipt.getByTestId('fee-covered')).toHaveText(
      'TipMe covered the fee on this tip.',
    );
    await expect(receipt.locator('.rrow').nth(2).locator('dd')).toHaveText(
      '₦2,000',
    );
    await expect(me.getByRole('main')).not.toContainText(PROVIDER_NAMES);
    await expectAccessible(me);
    await shoot(me, 't10-tip-covered', async () => {
      await expect(receipt.getByTestId('fee-covered')).toBeVisible();
    });

    // Every withdrawal carries the fee (profit guards, owner 25 Nov 2026): under the waiver it is Free.
    let summary = await chooseEverything(me);
    await expect(summary.getByTestId('transfer-fee')).toHaveText('Free');
    await expect(summary.getByTestId('you-receive')).toHaveText('₦2,000');
    await expect(me.getByRole('main')).not.toContainText(PROVIDER_NAMES);
    await expectAccessible(me);
    await shoot(me, 't10-withdraw-free', async () => {
      await me.getByRole('button', { name: 'Everything' }).click();
      await expect(summary.getByTestId('transfer-fee')).toHaveText('Free');
    });

    // The end date passes.
    await endWaivers({ profileId }, ['tip', 'withdrawal']);

    // The next tip carries the normal fee, and says nothing about cover.
    await tipAsVisitor(browser, handle);
    const normalTip = await newestTipId(profileId, waivedTip);
    receipt = await openTip(me, normalTip);
    await expect(receipt.locator('.rrow').nth(1).locator('dt')).toHaveText(
      'TipMe fee (5%, includes processing)',
    );
    await expect(receipt.locator('.rrow').nth(1).locator('dd')).toHaveText(
      '−₦100',
    );
    await expect(receipt.getByTestId('fee-covered')).toHaveCount(0);
    await expect(me.getByRole('main')).not.toContainText(PROVIDER_NAMES);
    await expectAccessible(me);
    // shoot reloads for each width: wait for the receipt each time, not the skeleton.
    await shoot(me, 't10-tip-after', async () => {
      await expect(receipt.getByText('You received')).toBeVisible({
        timeout: 15_000,
      });
      await expect(receipt.locator('.rrow').nth(1).locator('dt')).toHaveText(
        'TipMe fee (5%, includes processing)',
      );
    });
    // The tip it covered still says so: its quote recorded the waiver.
    receipt = await openTip(me, waivedTip);
    await expect(receipt.getByTestId('fee-covered')).toBeVisible();

    // The dashboard line is gone.
    main = await openDashboard(me);
    await expect(main.getByTestId('balance')).toBeVisible();
    await expect(main.getByTestId('tip-fee-waiver')).toHaveCount(0);
    await expect(main).not.toContainText(/covering the fee/);
    await expectAccessible(me);
    await shoot(me, 't10-dashboard-after', async () => {
      await expect(main.getByTestId('balance')).toBeVisible({
        timeout: 15_000,
      });
    });

    // The withdrawal shows its fee again.
    summary = await chooseEverything(me);
    await expect(summary.getByTestId('transfer-fee')).toHaveText('₦50');
    await expect(me.getByRole('main')).not.toContainText(PROVIDER_NAMES);
    await expectAccessible(me);
    await shoot(me, 't10-withdraw-after', async () => {
      await me.getByRole('button', { name: 'Everything' }).click();
      await expect(summary.getByTestId('transfer-fee')).toHaveText('₦50');
    });
  } finally {
    await second.context.close();
    await recipient.context.close();
  }
});

// §7: a business's withdrawals show "Free" while its waiver is in force. The rule is written as an
// approved change leaves it; the staff flow is the test above.
test('a business’s money screen says Transfer fee: Free while TipMe pays, and the fee after', async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(240_000);
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({ owner: userId });
  const { memberId } = await seedMember({
    locationId: business.locations[0]!.id,
    profileId,
    shownName: 'Kemi',
  });
  await seedAgreement({ memberId, proposedByUser: userId, businessBps: 5000 });
  // A ₦40,000 tip at the business, half of it shared with the business (as business-money.spec.ts).
  const quote = await (
    await request.post(`${API_ORIGIN}/v1/tip-quotes`, {
      data: {
        handle: who.handle,
        amountMinor: '4000000',
        currency: 'NGN',
        businessMemberId: memberId,
      },
    })
  ).json();
  const intent = await (
    await request.post(`${API_ORIGIN}/v1/tip-intents`, {
      headers: { 'idempotency-key': randomUUID() },
      data: { quoteId: quote.data.quoteId, businessMemberId: memberId },
    })
  ).json();
  const reference = String(intent.data.checkoutUrl).split('/mock-checkout/')[1];
  await request.post(`${API_ORIGIN}/v1/mock-provider/checkout/${reference}`, {
    data: { outcome: 'succeed' },
  });
  const [approver] = await sql<{ id: string }>(
    `SELECT id FROM users WHERE id <> $1 ORDER BY created_at LIMIT 1`,
    [userId],
  );
  await withDatabase(async (db, ops) => {
    await ops.setFeeWaiver(db, {
      scope: 'account',
      kind: 'business',
      businessId: business.businessId,
      fee: 'withdrawal',
      payer: 'tipme',
      staffUserId: userId,
      approvedBy: approver!.id,
      reason: 'Launch partner, TipMe covers transfers',
      now: new Date(),
    });
  });

  const money = page.locator('#money');
  const open = async () => {
    await expect(async () => {
      await page.goto('/dashboard/business');
      // Each visit reads the quote once; on a busy stack a load can take several seconds.
      await expect(money.getByText('Ready to withdraw')).toBeVisible({
        timeout: 10_000,
      });
    }).toPass({ timeout: 90_000 });
    await money.getByRole('button', { name: 'Everything' }).click();
  };
  await open();
  const balance = (await money.getByTestId('business-balance').textContent())!;
  await expect(money.getByTestId('business-you-receive')).toHaveText(
    `Transfer fee: Free. The business receives ${balance}.`,
  );
  await expect(page.getByRole('main')).not.toContainText(PROVIDER_NAMES);
  await expectAccessible(page);
  await shoot(
    page,
    't10-business-free',
    async () => {
      await expect(money.getByText('Ready to withdraw')).toBeVisible();
      await money.getByRole('button', { name: 'Everything' }).click();
    },
    money,
  );

  await endWaivers({ businessId: business.businessId }, ['withdrawal']);
  await open();
  await expect(money.getByTestId('business-you-receive')).toContainText(
    'Transfer fee: ₦50, charged by our payment partner.',
  );
  await shoot(
    page,
    't10-business-after',
    async () => {
      await expect(money.getByText('Ready to withdraw')).toBeVisible();
      await money.getByRole('button', { name: 'Everything' }).click();
    },
    money,
  );
});
