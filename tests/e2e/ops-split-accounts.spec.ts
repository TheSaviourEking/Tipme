import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { enrolOwner, withDatabase } from './ops-helpers';
import { shoot } from './split-shots';
import { E2E_REDIS_URL, stackEnv } from './stack';

/*
 * Per-provider balances, Task 11 (spec §7): staff see a split account (money at the active pretend
 * provider `mock` and the test-only withdraw-only `mock_alt`), read its balances now, and see
 * `mock_alt`'s retire state on Providers. Staff screens may name providers.
 */

type Raw = { execute(query: string): Promise<{ rows: { id: string }[] }> };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped dist import in tests
type Ops = Record<string, any>;

const fits = (page: Page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <=
      document.documentElement.clientWidth,
  );

/** A ₦2,000 tip to `handle` collected through `mock_alt`, as its webhook would record it. */
async function tipThroughAlt(handle: string) {
  return withDatabase(async (db, ops: Ops) => {
    const quote = await ops.createQuote(db, {
      handle,
      tipMinor: 200000n,
      currency: 'NGN',
      activeProvider: 'mock',
    });
    const intent = await ops.createPaymentIntent(db, {
      quoteId: quote.quoteId,
      idempotencyKey: randomUUID(),
    });
    const reference = `mock_alt_pay_${randomUUID()}`;
    await ops.markAttemptInitiated(db, {
      attemptId: intent.attemptId,
      provider: 'mock_alt',
      providerReference: reference,
    });
    await ops.recordProviderEvent(db, {
      provider: 'mock_alt',
      providerEventId: `evt_${randomUUID()}`,
      eventType: 'payment.succeeded',
      attemptId: intent.attemptId,
      providerReference: reference,
      amountMinor: 200000n,
      currency: 'NGN',
      providerFeeMinor: 3000n,
      signatureVerified: true,
      payload: {},
    });
    const { rows } = await (db as Raw).execute(
      `SELECT id FROM profiles WHERE handle = '${handle}'`,
    );
    const profileId = rows[0]!.id;
    // Yesterday's daily check said short, and its re-read cleared it: no issue opened.
    await (db as Raw).execute(
      `INSERT INTO provider_split_checks (id, profile_id, checked_at, ledger_minor, providers, outcome)
       VALUES ('${randomUUID()}', '${profileId}', now() - interval '1 day', 190000,
               '[{"provider":"mock_alt","availableMinor":"0","queuedMinor":"0"},
                 {"provider":"mock","availableMinor":"0","queuedMinor":"0"}]'::jsonb, 'short')`,
    );
    return profileId;
  });
}

/** What `mock_alt` says it holds for this person (its own keys, `<prefix>:mock_alt`). */
async function markAltBalance(profileId: string, minor: bigint) {
  // ioredis is the payments package's own dependency, as scripts/mock-pay.mjs loads it.
  const { Redis } = createRequire(
    join(__dirname, '../../packages/payments/package.json'),
  )('ioredis') as {
    Redis: new (url: string) => {
      set(key: string, value: string): Promise<unknown>;
      disconnect(): void;
    };
  };
  const redis = new Redis(E2E_REDIS_URL);
  try {
    await redis.set(
      `mockprovider:${stackEnv.QUEUE_PREFIX}:mock_alt:payout-balance:${profileId}`,
      minor.toString(),
    );
  } finally {
    redis.disconnect();
  }
}

/** The owner's row; other tests share the list, so more pages are opened until it shows. */
async function rowOf(page: Page, handle: string) {
  const row = page
    .getByRole('table', { name: 'Split accounts' })
    .getByTestId('split-account')
    .filter({ hasText: `@${handle}` });
  const more = page.getByRole('button', { name: 'Show more' });
  await expect(async () => {
    if ((await row.count()) === 0 && (await more.isVisible()))
      await more.click();
    await expect(row).toHaveCount(1, { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  return row;
}

test("staff see a split account and a withdraw-only provider's retire state", async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const recipientPage = await (await browser.newContext()).newPage();
  const { handle } = await signUpRecipient(recipientPage, testInfo);
  await recipientPage.close();
  const profileId = await tipThroughAlt(handle);
  await markAltBalance(profileId, 190000n);
  await enrolOwner(page, testInfo);

  // In the menu, under Work.
  await page.goto('/ops/split-accounts');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Split accounts' }),
  ).toBeVisible();
  const row = await rowOf(page, handle);
  await expect(row).toContainText('mock_alt');
  await expect(row).toContainText('Withdraw-only');
  await expect(row).toContainText('Active');
  await expect(row).toContainText('₦1,900');
  // A short check with no open issue says it wasn't confirmed, so staff don't go looking.
  await expect(row).toContainText('Short');
  await expect(row).toContainText('not confirmed on recheck');
  expect(await fits(page)).toBe(true);
  await expectAccessible(page);

  // On a phone each row is a card with the same fields, and nothing scrolls sideways.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  const phoneRow = await rowOf(page, handle);
  await expect(phoneRow).toContainText('not confirmed on recheck');
  expect(await fits(page)).toBe(true);
  await expectAccessible(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();

  // Read now: each provider's balance, by name.
  const row2 = await rowOf(page, handle);
  await row2.getByRole('button', { name: 'Read balances now' }).click();
  await expect(row2).toContainText('holds ₦1,900');
  await expectAccessible(page);
  await shoot(page, 'split-accounts', async () => {
    const shown = await rowOf(page, handle);
    await shown.getByRole('button', { name: 'Read balances now' }).click();
    await expect(shown).toContainText('holds ₦1,900');
  });

  // Providers: the retire check for mock_alt, tipped through today, so not yet.
  await page.goto('/ops/providers');
  const section = page.getByTestId('payment-providers');
  await expect(
    section.getByRole('heading', { name: 'Payment providers' }),
  ).toBeVisible();
  const retire = section.getByTestId('retire-mock_alt');
  await expect(retire).toContainText('Not yet');
  await expect(retire).toContainText('Owners with money');
  await expect(retire).toContainText('Open payouts');
  await expect(retire).toContainText('Last money movement');
  expect(await fits(page)).toBe(true);
  await expectAccessible(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(section.getByTestId('retire-mock_alt')).toContainText('Not yet');
  expect(await fits(page)).toBe(true);
  await expectAccessible(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.reload();
  await shoot(
    page,
    'providers-retire',
    async () => {
      await expect(section.getByTestId('retire-mock_alt')).toBeVisible();
    },
    section,
  );
});
