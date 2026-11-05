import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';
import { tipFromProfile } from '../shared/tip-flow';

const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export async function expectAccessible(page: Page) {
  const { violations } = await new AxeBuilder({ page })
    .withTags(wcag)
    .analyze();
  expect(
    violations.map(
      ({ id, nodes }) =>
        `${id}: ${nodes.map((n) => n.target.join(' ')).join(', ')}`,
    ),
  ).toEqual([]);
}
export const fitsViewport = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

/** A unique Nigerian mobile number and handle per test, so parallel workers and projects never collide. */
export function identity(testInfo: {
  project: { name: string };
  workerIndex: number;
}) {
  const project = testInfo.project.name === 'mobile' ? 1 : 0;
  // Worker and project last: the pretend inbox shows only the last four digits, and
  // tests running at the same moment must never share them.
  const digits = `${String(Date.now()).slice(-5)}${testInfo.workerIndex % 10}${project}`;
  return {
    phone: `+234803${digits}`,
    // The inbox shows only the first letter and the domain, so the domain keeps tests apart.
    email: `kemi@e2e-${digits}.example`,
    handle: `e2e_${digits}`,
  };
}

const hintOf = (email: string) => {
  const [local = '', domain = ''] = email.toLowerCase().split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

/** Sign-in code emails to this address that have arrived so far, newest first. */
async function codeEmails(page: Page, email: string): Promise<string[]> {
  const inbox = await page.context().newPage();
  try {
    await inbox.goto('/dev/inbox');
    // The list is fetched after hydration; reading it earlier looks like an empty inbox.
    await expect(
      inbox
        .getByRole('article')
        .first()
        .or(inbox.getByText('Nothing has been sent yet.')),
    ).toBeVisible({ timeout: 10_000 });
    return await inbox
      .getByRole('article')
      .filter({ hasText: hintOf(email) })
      .filter({ hasText: 'Your TipMe sign-in code' })
      .allTextContents();
  } finally {
    await inbox.close();
  }
}

/** Signs in with an email code, reading the code from the pretend inbox. */
export async function signInWithEmail(
  page: Page,
  email: string,
  start = '/sign-in',
) {
  const before = (await codeEmails(page, email)).length;
  await page.goto(start);
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  // The worker sends it shortly after; wait for this one, not an earlier sign-in's.
  let code = '';
  await expect(async () => {
    const mails = await codeEmails(page, email);
    expect(mails.length).toBeGreaterThan(before);
    code = /\b(\d{6})\b/.exec(mails[0] ?? '')?.[1] ?? '';
    expect(code).not.toBe('');
  }).toPass({ timeout: 25_000 });
  await page.getByLabel('6-digit code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Signs up a new recipient, claims a handle and (optionally) makes the page live. */
export async function signUpRecipient(
  page: Page,
  testInfo: { project: { name: string }; workerIndex: number },
  { live = true }: { live?: boolean } = {},
) {
  const who = identity(testInfo);
  await signInWithEmail(page, who.email, '/sign-up');
  await page.getByLabel('Handle').fill(who.handle);
  await expect(page.getByText(`@${who.handle} is available`)).toBeVisible();
  await page.getByRole('button', { name: `Claim @${who.handle}` }).click();
  // A new page lands on the welcome; these helpers continue from Settings.
  await page.waitForURL(/\/dashboard\/welcome$/);
  await page.goto('/dashboard/settings');
  if (live) {
    await page.getByRole('button', { name: 'Make my page live' }).click();
    await expect(page.getByText('Your page is live')).toBeVisible();
  }
  return who;
}

/** A visitor (own browser context) tips a recipient through the pretend provider. */
export async function tipAsVisitor(
  browser: Browser,
  handle: string,
  {
    amount = '2,000 NGN',
    name,
    message,
    outcome = /^Pay/,
  }: {
    amount?: string;
    name?: string;
    message?: string;
    outcome?: RegExp;
  } = {},
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await expect(async () => {
    await page.goto(`/@${handle}`);
    await expect(page.getByRole('radio', { name: amount })).toBeVisible({
      timeout: 1000,
    });
  }).toPass({ timeout: 10_000 });
  await tipFromProfile(page, {
    amount,
    outcome,
    ...(name ? { name } : {}),
    ...(message ? { message } : {}),
  });
  await context.close();
}

/**
 * How an error reads (states plan, PR A review I2). Beside an invalid field the line is black and
 * the field carries the red edge; a line with no field edge beside it keeps the red.
 */
export const DANGER_TEXT = 'rgb(155, 40, 32)';
export const PLAIN_TEXT = 'rgb(0, 0, 0)';
export const errorColour = (line: Locator) =>
  line.evaluate((el) => getComputedStyle(el).color);
/** True when the field shows B's red edge: the inset lamp-red line on its left. */
export const hasRedEdge = (field: Locator) =>
  field.evaluate((el) =>
    /rgb\(194, 56, 44\) 3px 0px 0px 0px inset|inset 3px 0px 0px 0px rgb\(194, 56, 44\)/.test(
      getComputedStyle(el).boxShadow,
    ),
  );
