import { randomUUID } from 'node:crypto';
import {
  expect,
  type APIRequestContext,
  type Browser,
  type Page,
} from '@playwright/test';
import { expectAccessible, identity, signInWithEmail } from './helpers';
import { API_ORIGIN, E2E_DATABASE_URL, E2E_MAIL_SEAL_KEY } from './stack';

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

/** Plain SQL against the e2e database: for the states a test sets up, never for what it checks. */
export async function sql<T = Record<string, unknown>>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const ops = await import('../../packages/database/dist/index.js');
  const handle = ops.createDatabase(E2E_DATABASE_URL, { max: 1 });
  try {
    return (await handle.pool.query(text, values)).rows as T[];
  } finally {
    await handle.close();
  }
}

/** A code the server will take now, however recently this person used one. */
export async function codeFor(person: { email: string; secret: string }) {
  await sql(
    `UPDATE staff_totp SET last_step = NULL
      WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
    [person.email],
  );
  return totpNow(person.secret);
}

/** As if this person's last code was an hour ago: the state an unattended laptop is in. */
export async function codeWentStale(person: { email: string }) {
  await sql(
    `UPDATE ops_sessions SET last_totp_at = now() - interval '1 hour'
      WHERE user_id = (SELECT id FROM users WHERE lower(email) = lower($1))`,
    [person.email],
  );
}

/** A second staff member, signed in in their own browser. */
export async function secondOwner(
  browser: Browser,
  testInfo: TestInfo & { project: { use: { baseURL?: string } } },
) {
  const context = await browser.newContext({
    baseURL: testInfo.project.use.baseURL,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  const person = await enrolOwner(page, testInfo);
  return { context, page, ...person };
}

/** The enrolment code an invited person was emailed, read as they would from their inbox. */
export async function emailedEnrolmentCode(email: string): Promise<string> {
  const { mailSealing, openSecret } =
    await import('../../packages/database/dist/index.js');
  const sealing = mailSealing(Buffer.from(E2E_MAIL_SEAL_KEY, 'base64'));
  const [row] = await sql<{ data_sealed: string }>(
    `SELECT m.data_sealed FROM mail_messages m JOIN users u ON u.id = m.user_id
      WHERE lower(u.email) = lower($1) AND m.type = 'staff_invitation'
      ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    [email],
  );
  if (!row) throw new Error('no invitation yet');
  return (
    JSON.parse(openSecret(sealing.key, row.data_sealed)) as { code: string }
  ).code;
}
