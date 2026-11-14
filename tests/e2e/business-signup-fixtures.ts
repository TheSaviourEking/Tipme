import { randomUUID } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { seedBusiness } from './business-fixtures';
import { identity, signInWithEmail } from './helpers';
import { sql, withDatabase, type TestInfo } from './ops-helpers';

// Business sign-up (Phase D): the e2e stack runs with BUSINESS_SIGNUP_ENABLED on
// (playwright.config.ts). Every person and business here is new per test.

export const dashboardNav = (page: Page) =>
  page.getByRole('navigation', { name: 'Dashboard' });

/** A login made by an email code, with no page (it stops at the handle step). */
export async function pagelessLogin(page: Page, testInfo: TestInfo) {
  const who = identity(testInfo);
  await signInWithEmail(page, who.email);
  await page.waitForURL(/\/sign-up/);
  const [row] = await sql<{ id: string }>(
    `SELECT id FROM users WHERE lower(email) = lower($1)`,
    [who.email],
  );
  if (!row) throw new Error(`no login for ${who.email}`);
  return { ...who, userId: row.id };
}

/** A login with no page that owns a business: the board's Ngozi. */
export async function businessOnlyOwner(
  page: Page,
  testInfo: TestInfo,
  {
    status = 'verified' as 'pending' | 'verified',
    name = 'Mama Put Lekki',
  } = {},
) {
  const who = await pagelessLogin(page, testInfo);
  const business = await seedBusiness({
    owner: who.userId,
    status,
    name,
    slug: `mama-${randomUUID().slice(0, 8)}`,
    locations: [{ slug: 'admiralty', name: 'Admiralty Way' }],
  });
  await sql(
    `UPDATE business_managers SET shown_name = 'Ngozi' WHERE business_id = $1`,
    [business.businessId],
  );
  return { ...who, ...business };
}

/** TipMe staff verify a waiting business: the serious action's own work, as ops runs it. */
export async function verifyAsStaff(businessId: string) {
  const staffId = randomUUID();
  await sql(`INSERT INTO users (id) VALUES ($1)`, [staffId]);
  await withDatabase(async (db, ops) => {
    await (
      db as {
        transaction: (
          task: (tx: unknown) => Promise<unknown>,
        ) => Promise<unknown>;
      }
    ).transaction((tx) =>
      ops.verifyBusiness(tx, {
        businessId,
        staffUserId: staffId,
        reason: 'Checked by e2e staff',
        now: new Date(),
      }),
    );
  });
}

/** The URLs the main frame opened from now on. */
export function recordNavigations(page: Page): string[] {
  const visited: string[] = [];
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) visited.push(new URL(frame.url()).pathname);
  });
  return visited;
}

export async function expectNoSignUp(visited: string[]) {
  expect(visited.filter((path) => path === '/sign-up')).toEqual([]);
}
