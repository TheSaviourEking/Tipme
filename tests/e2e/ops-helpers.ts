import { randomUUID } from 'node:crypto';
import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { expectAccessible, identity, signInWithEmail } from './helpers';
import { API_ORIGIN, E2E_DATABASE_URL } from './stack';

// Admin-area helpers (PR-009): staff are granted through the database, as the command does.

export type TestInfo = { project: { name: string }; workerIndex: number };

/** Runs a database operation against the e2e database (granting staff is never a web action). */
export async function withDatabase<T>(
  task: (db: unknown, ops: Record<string, any>) => Promise<T>, // eslint-disable-line @typescript-eslint/no-explicit-any -- untyped dist import in tests
): Promise<T> {
  const ops = await import('../../packages/database/dist/index.js');
  const handle = ops.createDatabase(E2E_DATABASE_URL, { max: 1 });
  try {
    return await task(handle.db, ops);
  } finally {
    await handle.close();
  }
}

export const totpNow = async (secret: string, offset = 0n) => {
  const { totpAt } = await import('../../packages/domain/dist/index.js');
  return totpAt(secret, BigInt(Math.floor(Date.now() / 30_000)) + offset);
};

/** As `pnpm ops:grant-owner` would: Owner role and a one-time enrolment code. */
export async function grantOwner(email: string): Promise<string> {
  return withDatabase(
    async (db, ops) =>
      (await ops.grantOwner(db, { email })).enrolmentCode as string,
  );
}

/** Signs in at /ops, enrols the authenticator and lands in the admin area. */
export async function enrolOwner(page: Page, testInfo: TestInfo) {
  const { email } = identity(testInfo);
  const enrolmentCode = await grantOwner(email);
  await signInWithEmail(page, email, '/sign-in?next=/ops');
  await page.waitForURL(/\/ops$/);
  await expect(
    page.getByRole('heading', { name: 'Set up your authenticator' }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.getByLabel('Enrolment code').fill(enrolmentCode);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(
    page.getByRole('img', { name: /QR code for your authenticator/ }),
  ).toBeVisible();
  const secret =
    (await page.getByTestId('totp-secret').textContent())?.replace(/\s/g, '') ??
    '';
  expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  await page.getByLabel('Authenticator code').fill(await totpNow(secret, 1n));
  await page.getByRole('button', { name: 'Confirm' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Admin' }).getByRole('link', {
      name: 'Issues',
    }),
  ).toBeVisible();
  return { email, secret };
}

/** A tip whose provider reports the wrong amount: a money issue in the inbox. */
export async function mismatchedTip(
  request: APIRequestContext,
  handle: string,
) {
  const quote = await (
    await request.post(`${API_ORIGIN}/v1/tip-quotes`, {
      data: { handle, amountMinor: '200000', currency: 'NGN' },
    })
  ).json();
  const intent = await (
    await request.post(`${API_ORIGIN}/v1/tip-intents`, {
      headers: { 'idempotency-key': randomUUID() },
      data: {
        quoteId: quote.data.quoteId,
        message: 'Private e2e words quux',
        payerDisplayLabel: 'Kept Private',
      },
    })
  ).json();
  const reference = intent.data.checkoutUrl.split('/mock-checkout/')[1];
  await request.post(`${API_ORIGIN}/v1/mock-provider/checkout/${reference}`, {
    data: { outcome: 'wrong-amount' },
  });
  let issueId = '';
  await expect(async () => {
    issueId = await withDatabase(async (db, ops) => {
      const issues = await ops.listIssues(db, {
        kind: 'payment_mismatch',
        limit: 100,
      });
      return (
        issues.find(
          (i: { subject: { tipId?: string } }) =>
            i.subject.tipId === intent.data.tipId,
        )?.id ?? ''
      );
    });
    expect(issueId).not.toBe('');
  }).toPass({ timeout: 15_000 });
  return issueId;
}
