import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type Page } from '@playwright/test';

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
  return { phone: `+234803${digits}`, handle: `e2e_${digits}` };
}

/** The newest code sent to this number (matched by its last four digits) in the pretend inbox. */
export async function readCode(page: Page, phone: string): Promise<string> {
  const inbox = await page.context().newPage();
  await inbox.goto('/dev/inbox');
  const message = inbox
    .getByRole('article')
    .filter({ hasText: `•••${phone.replace(/\D/g, '').slice(-4)}` })
    .filter({ hasText: 'Your TipMe code is' })
    .first();
  await expect(message).toBeVisible();
  const code =
    /\b(\d{6})\b/.exec((await message.textContent()) ?? '')?.[1] ?? '';
  await inbox.close();
  return code;
}

export async function signInWithPhone(
  page: Page,
  phone: string,
  start = '/sign-in',
) {
  await page.goto(start);
  await page.getByLabel('Phone number').fill(phone);
  await page.getByRole('button', { name: 'Send code' }).click();
  await expect(page.getByLabel('6-digit code')).toBeVisible();
  await page.getByLabel('6-digit code').fill(await readCode(page, phone));
  await page.getByRole('button', { name: 'Continue' }).click();
}

/** Signs up a new recipient, claims a handle and (optionally) makes the page live. */
export async function signUpRecipient(
  page: Page,
  testInfo: { project: { name: string }; workerIndex: number },
  { live = true }: { live?: boolean } = {},
) {
  const who = identity(testInfo);
  await signInWithPhone(page, who.phone, '/sign-up');
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
  await page.getByRole('radio', { name: amount }).check();
  await expect(page.getByText(/^You pay NGN [\d,]+\.\d\d$/)).toBeVisible();
  if (message)
    await page.getByLabel('Personal message (optional)').fill(message);
  if (name) {
    // The profile keeps the optional extras behind a disclosure.
    await page.getByText('Add your name or remember tips').click();
    await page.getByLabel('Your name (optional)').fill(name);
  }
  await page.getByRole('button', { name: /^Tip NGN/ }).click();
  await page.waitForURL(/\/mock-checkout\//);
  await page.getByRole('button', { name: outcome }).click();
  await page.waitForURL(/\/tip\//);
  await context.close();
}
