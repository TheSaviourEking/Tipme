import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseBank } from './bank-fixtures';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { E2E_REDIS_URL, LANE, stackEnv } from './stack';
import { startTip } from '../shared/tip-flow';

/*
 * You collect, end to end in the browser (plan Task 16; Task 7's pretend collect checkout page):
 * a new recipient on You collect takes a tip before adding any bank details, adds them at their
 * first withdrawal, and withdraws once the tip has moved to them. The `you_collect` switch stays off
 * on this shared stack (turning it on would change every other spec's sign-ups), so the test puts
 * its own page on `collect`, as a sign-up with the switch on does; the switch itself is proven in
 * tests/integration/you-collect-journey.test.mjs. Everything after that is the real web app, API
 * and worker on the pretend payment partner. No real money and no real partner.
 */

const COPY = {
  noBank:
    'You can take tips now. Add your bank details when you want to withdraw.',
  kept: 'Kept for you until you add your bank details.',
  addBank: 'Add bank details to withdraw',
  verified: 'You’re all set. Your tips are on their way to you.',
} as const;

const BANK = 'Pretend Guaranty Bank';

// A route stub still running when a test ends must not fail it with "Response has been disposed".
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

type TestDatabase = {
  db: unknown;
  pool: {
    query<T>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  };
  close(): Promise<void>;
};

async function database(): Promise<TestDatabase> {
  const { openTestDatabase } =
    await import('../../packages/database/dist/test-support.js');
  return openTestDatabase() as Promise<TestDatabase>;
}

const hintOf = (email: string) => {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

/** The newest bank-account code email to this address, once it has arrived. */
async function bankCode(page: Page, email: string) {
  const inbox = await page.context().newPage();
  try {
    let found = '';
    await expect(async () => {
      await inbox.goto('/dev/inbox');
      await expect(inbox.getByRole('article').first()).toBeVisible();
      const mails = await inbox
        .getByRole('article')
        .filter({ hasText: hintOf(email) })
        .filter({ hasText: 'Confirm your TipMe bank account' })
        .allTextContents();
      found = /\b(\d{6})\b/.exec(mails[0] ?? '')?.[1] ?? '';
      expect(found).not.toBe('');
    }).toPass({ timeout: 20_000 });
    return found;
  } finally {
    await inbox.close();
  }
}

/** The phone's Bank field is a button that opens a sheet; a desktop's is a combobox. */
async function pickBank(page: Page, form: Locator) {
  if ((page.viewportSize()?.width ?? 0) > 640)
    return chooseBank(form, 'guaranty', BANK);
  await form.getByRole('button', { name: /^Bank/ }).click();
  const sheet = form.getByRole('dialog', { name: 'Choose your bank' });
  await sheet
    .getByRole('combobox', { name: 'Search your bank' })
    .fill('guaranty');
  await sheet.getByRole('option', { name: BANK, exact: true }).click();
  await expect(sheet).toBeHidden();
}

/** The worker's collect transfer sweep, run once here against the lane's pretend partner. */
async function sweepTransfers(db: TestDatabase) {
  // The worker's build has no type declarations: its two exports, typed here.
  const workerModule = '../../apps/worker/dist/handlers/collect-transfers.js';
  const { handleCollectTransfers, collectTransferProviders } = (await import(
    workerModule
  )) as {
    handleCollectTransfers: (deps: {
      db: never;
      providers: unknown;
      log: (entry: unknown) => void;
    }) => Promise<unknown>;
    collectTransferProviders: (providers: never[]) => unknown;
  };
  const { createMockProvider } =
    await import('../../packages/payments/dist/index.js');
  const { Redis } = createRequire(
    join(__dirname, '../../packages/payments/package.json'),
  )('ioredis') as { Redis: new (url: string) => { disconnect(): void } };
  const redis = new Redis(E2E_REDIS_URL);
  try {
    const provider = createMockProvider({
      redis: redis as never,
      secret: stackEnv.MOCK_PROVIDER_WEBHOOK_SECRET,
      prefix: LANE.queuePrefix,
    });
    await handleCollectTransfers({
      db: db.db as never,
      providers: collectTransferProviders([provider as never]),
      log: () => {},
    });
  } finally {
    redis.disconnect();
  }
}

test('a new recipient takes a tip before verifying and withdraws after adding bank details', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const db = await database();
  try {
    // 1. A new page on You collect, live, with no payment account and no bank.
    const { email, handle } = await signUpRecipient(page, testInfo);
    const { rows } = await db.pool.query<{ id: string }>(
      `UPDATE profiles SET collection_mode = 'collect' WHERE handle_lower = $1 RETURNING id`,
      [handle.toLowerCase()],
    );
    expect(rows).toHaveLength(1);
    const profileId = rows[0]!.id;
    await page.goto('/dashboard');
    const main = page.getByRole('main');
    await expect(main.getByText(COPY.noBank)).toBeVisible();

    // 2. A supporter tips. The checkout is TipMe's own (the pretend partner's collect checkout).
    const context = await browser.newContext();
    const supporter = await context.newPage();
    await expect(async () => {
      await supporter.goto(`/@${handle}`);
      await expect(
        supporter.getByRole('radio', { name: '2,000 NGN' }),
      ).toBeVisible({ timeout: 1000 });
    }).toPass({ timeout: 10_000 });
    await startTip(supporter);
    await supporter.waitForURL(/\/mock-checkout\/platform(%3A|:)mock_collect_/);
    const checkout = supporter.getByRole('region', {
      name: 'Confirm payment',
    });
    await expect(
      checkout.getByText('Test payment page · no real money'),
    ).toBeVisible();
    await expect(checkout.locator('.mock-provider__amount')).toContainText(
      '2,000',
    );
    await expect(checkout.getByText(`To ${handle}, via TipMe`)).toBeVisible();
    await expectAccessible(supporter);
    await checkout
      .getByRole('button', { name: /^Pay The payment succeeds/ })
      .click();
    await supporter.waitForURL(/\/tip\//);
    const receipt = supporter.getByRole('region', { name: 'Your receipt' });
    await expect(receipt).toBeVisible({ timeout: 30_000 });
    await expect(
      receipt.getByText(`Paid to TipMe for ${handle}`),
    ).toBeVisible();
    await expect(supporter.locator('body')).not.toContainText(/bachs/i);
    await context.close();

    // 3. Held for them: kept, not withdrawable, and Withdraw asks for bank details first.
    const share = async () =>
      (
        await db.pool.query<{ status: string }>(
          `SELECT c.status FROM collect_transfers c WHERE c.profile_id = $1 AND c.kind = 'share'`,
          [profileId],
        )
      ).rows[0]?.status ?? 'none';
    await expect.poll(share, { timeout: 20_000 }).toBe('waiting');
    await page.goto('/dashboard');
    const balance = main.getByRole('region', { name: 'Your balance' });
    await expect(balance.getByTestId('kept')).toContainText(COPY.kept);
    await expect(balance.getByTestId('ready')).toHaveCount(0);
    await page.goto('/dashboard/withdraw');
    const form = page.getByRole('region', { name: COPY.addBank });
    await expect(form).toBeVisible();
    await expect(page.getByLabel('Amount (NGN)')).toHaveCount(0);

    // 4. Bank details: their name, their bank, the code from their email. Verified.
    await form.getByLabel('First name').fill('Ada');
    await form.getByLabel('Last name').fill('Okafor');
    await pickBank(page, form);
    const accountNumber = `5${String(Date.now()).slice(-8)}${testInfo.workerIndex % 10}`;
    await form.getByLabel('Account number').fill(accountNumber);
    await form.getByRole('button', { name: 'Continue' }).click();
    await expect(
      form.getByText('Is this you? PRETEND ACCOUNT HOLDER'),
    ).toBeVisible();
    await form.getByRole('button', { name: 'Confirm' }).click();
    await form.getByLabel('6-digit code').fill(await bankCode(page, email));
    await form.getByRole('button', { name: 'Add bank details' }).click();
    await expect(main.getByText(COPY.verified)).toBeVisible();
    await expect(page.locator('body')).not.toContainText(accountNumber);

    // 5. The tip moves to them. A new recipient's share waits 24 hours (spec §8): that wait is
    //    over here, and the worker's sweep sends it.
    await db.pool.query(
      `UPDATE collect_transfers SET release_after = now() - interval '1 minute'
        WHERE profile_id = $1 AND kind = 'share'`,
      [profileId],
    );
    await expect
      .poll(
        async () => {
          if ((await share()) !== 'paid') await sweepTransfers(db);
          return share();
        },
        { timeout: 30_000 },
      )
      .toBe('paid');

    // 6. A first withdrawal, within the first cap.
    await expect(async () => {
      await page.goto('/dashboard/withdraw');
      await expect(page.getByLabel('Amount (NGN)')).toBeVisible({
        timeout: 2000,
      });
    }).toPass({ timeout: 20_000 });
    await expect(
      main.getByText(
        /^New accounts can withdraw up to ₦50,000 the first time\.$/,
      ),
    ).toBeVisible();
    await page.getByLabel('Amount (NGN)').fill('1900');
    // The whole balance: the reload after it reads ₦0, and the slip must still say it (review I1).
    const reloaded = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/me/dashboard') &&
        response.request().method() === 'GET',
    );
    await page.getByRole('button', { name: 'Withdraw ₦1,900' }).click();
    await expect(page.getByText('Withdrawal requested')).toBeVisible();
    await reloaded;
    await expect(page.getByTestId('withdraw-available')).toHaveText('₦0');
    await expect(page.getByText('Withdrawal requested')).toBeVisible();
    const history = page.getByRole('region', { name: 'Your withdrawals' });
    await expect(
      history.getByRole('listitem').filter({ hasText: '₦1,900' }),
    ).toContainText(/Requested|On its way|Paid/);
    expect(await fitsViewport(page)).toBe(true);
    await expect(page.locator('body')).not.toContainText(/bachs/i);
  } finally {
    await db.close();
  }
});
