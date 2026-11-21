import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { chooseBank } from './bank-fixtures';
import {
  expectAccessible,
  fitsViewport,
  signUpRecipient,
  tipAsVisitor,
} from './helpers';
import { API_ORIGIN, E2E_REDIS_URL, LANE } from './stack';
import { tipFromProfile } from '../shared/tip-flow';

/*
 * You collect (plan Task 14, spec §2 and §10): what a recipient on `collect` and their supporters
 * see. The `you_collect` switch stays off on this stack, so every sign-up here is undecided
 * (direct); a test puts its own page on `collect` in the lane's database, as a sign-up with the
 * switch on would. Everything after that is the real API on the pretend payment partner.
 */

// The spec's words (§10), as a reader sees them. COLLECT_COPY is checked against the spec in
// apps/web/test/collect-copy.test.mjs; these are what the browser must show.
const COPY = {
  noBank:
    'You can take tips now. Add your bank details when you want to withdraw.',
  kept: 'Kept for you until you add your bank details.',
  addBank: 'Add bank details to withdraw',
  ownName: 'Use a bank account in your own name.',
  checking: "We're checking your details. This usually takes a few minutes.",
  manual: "We're checking this by hand. We'll tell you when it's done.",
  mismatch:
    "This account isn't in your name. Use a bank account in your own name.",
  verified: "You're all set. Your tips are on their way to you.",
  paused:
    'Your page has paused tips. Add your bank details to start taking tips again.',
} as const;

const VIEWPORTS = [
  ['phone', { width: 390, height: 844 }],
  ['desktop', { width: 1440, height: 900 }],
] as const;

async function database() {
  const { openTestDatabase } =
    await import('../../packages/database/dist/test-support.js');
  return openTestDatabase();
}

/** Puts this handle's page on You collect, as a sign-up with the switch on does. Returns its id. */
async function putOnCollect(handle: string): Promise<string> {
  const db = await database();
  try {
    const { rows } = await db.pool.query<{ id: string }>(
      `UPDATE profiles SET collection_mode = 'collect'
        WHERE handle_lower = $1 RETURNING id`,
      [handle.toLowerCase()],
    );
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  } finally {
    await db.close();
  }
}

async function collectionModeOf(handle: string): Promise<string | null> {
  const db = await database();
  try {
    const { rows } = await db.pool.query<{ mode: string | null }>(
      `SELECT collection_mode AS mode FROM profiles WHERE handle_lower = $1`,
      [handle.toLowerCase()],
    );
    return rows[0]?.mode ?? null;
  } finally {
    await db.close();
  }
}

/**
 * The pretend partner's next answer for this recipient's bank (the mock's markCollectAnswer): its
 * account reference is the profile id, as the pretend partner has no accounts.
 */
async function partnerAnswers(
  profileId: string,
  answer: 'destination-rejected' | 'destination-pending-review',
) {
  // ioredis is the payments package's own dependency, as scripts/mock-pay.mjs loads it.
  const { Redis } = createRequire(
    join(__dirname, '../../packages/payments/package.json'),
  )('ioredis') as typeof import('ioredis');
  const redis = new Redis(E2E_REDIS_URL);
  try {
    await redis.set(
      `mockprovider:${LANE.queuePrefix}:collect-answer:${profileId}`,
      answer,
    );
  } finally {
    redis.disconnect();
  }
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
    }).toPass({ timeout: 15_000 });
    return found;
  } finally {
    await inbox.close();
  }
}

/** A new recipient whose page is live and on You collect, on their Withdraw page. */
async function collectRecipient(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
) {
  const who = await signUpRecipient(page, testInfo);
  const profileId = await putOnCollect(who.handle);
  return { ...who, profileId };
}

/** The add-bank-details form on Withdraw. */
const bankForm = (page: Page) =>
  page.getByRole('region', { name: COPY.addBank });

const BANK = 'Pretend Guaranty Bank';

/** The phone's Bank field is a button that opens a full-screen sheet; a desktop's is a combobox. */
const onPhone = (page: Page) => (page.viewportSize()?.width ?? 0) <= 640;

async function pickBank(page: Page, form: Locator) {
  if (!onPhone(page)) return chooseBank(form, 'guaranty', BANK);
  await form.getByRole('button', { name: /^Bank/ }).click();
  const sheet = form.getByRole('dialog', { name: 'Choose your bank' });
  await sheet
    .getByRole('combobox', { name: 'Search your bank' })
    .fill('guaranty');
  await sheet.getByRole('option', { name: BANK, exact: true }).click();
  await expect(sheet).toBeHidden();
  await expect(
    form.getByRole('button', { name: /^Bank/ }),
  ).toHaveAccessibleName(`Bank ${BANK}`);
}

/** Fills the details step and asks for the bank's name. */
async function enterDetails(
  page: Page,
  form: Locator,
  accountNumber = '0123456789',
) {
  await form.getByLabel('First name').fill('Ada');
  await form.getByLabel('Last name').fill('Okafor');
  await pickBank(page, form);
  await form.getByLabel('Account number').fill(accountNumber);
  await form.getByRole('button', { name: 'Continue' }).click();
}

/** From "Is this you?" to the code step, and the code from the inbox entered. */
async function confirmAndEnterCode(page: Page, form: Locator, email: string) {
  await expect(
    form.getByText('Is this you? PRETEND ACCOUNT HOLDER'),
  ).toBeVisible();
  await form.getByRole('button', { name: 'Confirm' }).click();
  const code = form.getByLabel('6-digit code');
  await expect(code).toBeVisible();
  await code.fill(await bankCode(page, email));
}

/** The words as they show (the form also says them in a screen-reader-only live line). */
const shownTo = (form: Locator, words: string) =>
  form.locator(':not(.sr-only)').filter({ hasText: words }).last();

/** Types the bank's name into a Bank search, moves to its option and presses Enter on it. */
async function chooseByKeys(page: Page, search: Locator) {
  await page.keyboard.type('guaranty');
  const option = page.getByRole('option', { name: BANK, exact: true });
  const optionId = (await option.getAttribute('id')) ?? '';
  await expect(async () => {
    if ((await search.getAttribute('aria-activedescendant')) !== optionId)
      await page.keyboard.press('ArrowDown');
    await expect(search).toHaveAttribute('aria-activedescendant', optionId, {
      timeout: 200,
    });
  }).toPass({ timeout: 5_000 });
  await page.keyboard.press('Enter');
}

for (const [label, viewport] of VIEWPORTS) {
  test.describe(`${label}`, () => {
    test.use({ viewport });

    test('a new collect recipient sees "You can take tips now…" and the kept-for-you note after a tip', async ({
      page,
      browser,
    }, testInfo) => {
      const { handle } = await collectRecipient(page, testInfo);

      await page.goto('/dashboard');
      const main = page.getByRole('main');
      await expect(main.getByText(COPY.noBank)).toBeVisible();
      await expect(
        main.getByRole('link', { name: COPY.addBank }),
      ).toHaveAttribute('href', '/dashboard/withdraw');

      await tipAsVisitor(browser, handle);
      await page.goto('/dashboard');
      const balance = main.getByRole('region', { name: 'Your balance' });
      await expect(balance.getByTestId('kept')).toContainText(COPY.kept);
      // The tip's share is in the balance, and none of it is ready to withdraw.
      await expect(balance.getByTestId('balance')).not.toHaveText('₦0');
      await expect(balance.getByTestId('ready')).toHaveCount(0);
      await expect(main.getByText(COPY.noBank)).toBeVisible();

      await page.goto('/dashboard/earnings');
      await expect(page.getByRole('main').getByTestId('kept')).toContainText(
        COPY.kept,
      );
      expect(await fitsViewport(page)).toBe(true);
    });

    test('adding bank details: confirm the name, see checking, then all set', async ({
      page,
    }, testInfo) => {
      const { email } = await collectRecipient(page, testInfo);
      await page.goto('/dashboard/withdraw');
      const form = bankForm(page);
      await expect(form.getByText(COPY.ownName)).toBeVisible();

      await enterDetails(page, form);
      await confirmAndEnterCode(page, form, email);

      // Hold the partner's answer, so the in-between state can be seen.
      let release = () => {};
      const held = new Promise<void>((resolve) => (release = resolve));
      await page.route('**/v1/me/collect/bank', async (route) => {
        await held;
        await route.continue();
      });
      await form.getByRole('button', { name: 'Add bank details' }).click();
      await expect(
        page.getByRole('main').getByText(COPY.checking),
      ).toBeVisible();
      release();

      const main = page.getByRole('main');
      await expect(main.getByText(COPY.verified)).toBeVisible();
      // Withdraw works as today, with the first withdrawal's cap said.
      await expect(
        main.getByText(
          /^New accounts can withdraw up to ₦[\d,]+ the first time\.$/,
        ),
      ).toBeVisible();
      await expect(bankForm(page)).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('0123456789');
      await expect(page.locator('body')).not.toContainText(/bachs/i);
      expect(await fitsViewport(page)).toBe(true);
    });

    test('a name mismatch says so and keeps nothing', async ({
      page,
    }, testInfo) => {
      const { email, profileId } = await collectRecipient(page, testInfo);
      await page.goto('/dashboard/withdraw');
      const form = bankForm(page);
      await enterDetails(page, form);
      await confirmAndEnterCode(page, form, email);
      await partnerAnswers(profileId, 'destination-rejected');
      await form.getByRole('button', { name: 'Add bank details' }).click();

      // The words are at the field, tied to it.
      const number = form.getByLabel('Account number');
      await expect(number).toHaveAttribute('aria-invalid', 'true');
      await expect(number).toHaveAccessibleDescription(
        new RegExp(COPY.mismatch.replace(/[.?]/g, '\\$&')),
      );
      await expect(page.getByRole('main').getByText(COPY.verified)).toHaveCount(
        0,
      );

      // Nothing was saved: no bank, and the form again after a reload.
      const status = await page.request.get(`${API_ORIGIN}/v1/me/collect`);
      expect(status.ok()).toBe(true);
      expect((await status.json()).data.bank).toBeNull();
      await page.reload();
      await expect(bankForm(page).getByLabel('Account number')).toHaveValue('');
    });

    test('manual review shows the by-hand message', async ({
      page,
    }, testInfo) => {
      const { email, profileId } = await collectRecipient(page, testInfo);
      await page.goto('/dashboard/withdraw');
      const form = bankForm(page);
      await enterDetails(page, form);
      await confirmAndEnterCode(page, form, email);
      await partnerAnswers(profileId, 'destination-pending-review');
      await form.getByRole('button', { name: 'Add bank details' }).click();

      const main = page.getByRole('main');
      await expect(main.getByText(COPY.manual)).toBeVisible();
      await page.reload();
      await expect(main.getByText(COPY.manual)).toBeVisible();
      await expect(main.getByText(COPY.verified)).toHaveCount(0);
    });

    test('a paused page tells the supporter only that they can’t take tips right now', async ({
      page,
      browser,
    }, testInfo) => {
      const { handle } = await collectRecipient(page, testInfo);
      const said = `${handle} can't take tips right now. Please try again later.`;

      // The recipient: the dashboard banner (the pause is the API's; held here, as reaching the
      // holding cap takes ₦50,000 or 30 days).
      await page.route('**/v1/me/events**', (route) =>
        route.fulfill({ status: 204 }),
      );
      await page.route('**/v1/me/collect', async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        await route.fulfill({
          response,
          json: {
            data: { ...body.data, paused: true, pausedReason: 'days' },
          },
        });
      });
      await page.goto('/dashboard');
      const banner = page.getByRole('main').getByText(COPY.paused);
      await expect(banner).toBeVisible();
      await expect(page.getByRole('main').getByText(COPY.noBank)).toHaveCount(
        0,
      );

      // The supporter: refused before paying, at the quote, with no reason and no amount.
      const context = await browser.newContext({ viewport });
      const supporter = await context.newPage();
      await supporter.route('**/v1/tip-quotes', (route) =>
        route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'PAGE_PAUSED',
              message:
                'This page can’t take tips right now. Please try again later.',
            },
          },
        }),
      );
      await supporter.goto(`/@${handle}`);
      await supporter.getByRole('radio', { name: '2,000 NGN' }).click();
      await supporter.getByRole('button', { name: /^Tip ₦/ }).click();
      const form = supporter.locator('form').filter({ hasText: said });
      await expect(shownTo(form, said)).toBeVisible();
      await expect(form).not.toContainText(
        /cap|limit|50,000|days|bank|paused/i,
      );
      expect(supporter.url()).not.toMatch(/mock-checkout/);

      // And at the intent, if the page paused after the quote: the same words, nothing charged.
      await supporter.unroute('**/v1/tip-quotes');
      await supporter.route('**/v1/tip-intents', (route) =>
        route.fulfill({
          status: 409,
          json: {
            error: {
              code: 'PAGE_PAUSED',
              message:
                'This page can’t take tips right now. Please try again later.',
            },
          },
        }),
      );
      await supporter.reload();
      await supporter.getByRole('radio', { name: '2,000 NGN' }).click();
      await supporter.getByRole('button', { name: /^Tip ₦/ }).click();
      await expect(shownTo(form, said)).toBeVisible();
      expect(supporter.url()).not.toMatch(/mock-checkout/);
      await context.close();
    });

    test('the receipt says Paid to TipMe for the person on a collect tip, and is unchanged on a direct tip', async ({
      page,
      browser,
    }, testInfo) => {
      const { handle } = await collectRecipient(page, testInfo);
      const context = await browser.newContext({ viewport });
      const supporter = await context.newPage();
      await supporter.goto(`/@${handle}`);
      await tipFromProfile(supporter);
      const receipt = supporter.getByRole('region', { name: 'Your receipt' });
      await expect(receipt).toBeVisible({ timeout: 30_000 });
      await expect(
        receipt.getByText(`Paid to TipMe for ${handle}`),
      ).toBeVisible();

      // A direct page (the switch is off: a sign-up is undecided, so direct): today's receipt.
      const other = await browser.newContext();
      const direct = await signUpRecipient(await other.newPage(), {
        ...testInfo,
        workerIndex: testInfo.workerIndex + 5,
      });
      expect(await collectionModeOf(direct.handle)).toBeNull();
      await supporter.goto(`/@${direct.handle}`);
      await tipFromProfile(supporter);
      await expect(receipt).toBeVisible({ timeout: 30_000 });
      await expect(receipt).not.toContainText('Paid to TipMe');
      await context.close();
      await other.close();
    });

    test('the add-bank-details form works by keyboard alone and passes axe', async ({
      page,
    }, testInfo) => {
      const { email } = await collectRecipient(page, testInfo);
      await page.goto('/dashboard/withdraw');
      const form = bankForm(page);
      await expect(form.getByLabel('First name')).toBeVisible();
      await expectAccessible(page);

      await form.getByLabel('First name').focus();
      await page.keyboard.type('Ada');
      await page.keyboard.press('Tab');
      await expect(form.getByLabel('Last name')).toBeFocused();
      await page.keyboard.type('Okafor');
      await page.keyboard.press('Tab');
      if (onPhone(page)) {
        // The phone's Bank button opens its sheet with the search ready (bank-picker.spec.ts).
        const trigger = form.getByRole('button', { name: /^Bank/ });
        await expect(trigger).toBeFocused();
        await page.keyboard.press('Enter');
        const search = form
          .getByRole('dialog', { name: 'Choose your bank' })
          .getByRole('combobox', { name: 'Search your bank' });
        await expect(search).toBeFocused();
        await chooseByKeys(page, search);
        await expect(trigger).toHaveAccessibleName(`Bank ${BANK}`);
        await expect(trigger).toBeFocused();
      } else {
        const bank = form.getByRole('combobox', { name: 'Bank' });
        await expect(bank).toBeFocused();
        await chooseByKeys(page, bank);
        await expect(bank).toHaveValue(BANK);
      }
      await page.keyboard.press('Tab');
      const number = form.getByLabel('Account number');
      await expect(number).toBeFocused();
      await page.keyboard.type('0123456789');
      await page.keyboard.press('Enter');

      // Each step's first key takes focus as it appears.
      const confirm = form.getByRole('button', { name: 'Confirm' });
      await expect(confirm).toBeFocused();
      await expectAccessible(page);
      await page.keyboard.press('Enter');
      const code = form.getByLabel('6-digit code');
      await expect(code).toBeFocused();
      await expectAccessible(page);
      await page.keyboard.type(await bankCode(page, email));
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('main').getByText(COPY.verified),
      ).toBeVisible();
      await expectAccessible(page);
    });
  });
}

test('nothing changes for a recipient who is not on You collect', async ({
  page,
  browser,
}, testInfo) => {
  // The switch is off on this stack: a new sign-up is undecided, which is direct.
  const { handle } = await signUpRecipient(page, testInfo);
  expect(await collectionModeOf(handle)).toBeNull();
  await tipAsVisitor(browser, handle);

  await page.goto('/dashboard');
  const main = page.getByRole('main');
  await expect(
    main.getByRole('region', { name: 'Your balance' }),
  ).toBeVisible();
  for (const words of [
    COPY.noBank,
    COPY.kept,
    COPY.paused,
    'On its way to you',
  ])
    await expect(main.getByText(words)).toHaveCount(0);

  await page.goto('/dashboard/withdraw');
  await expect(
    main.getByRole('heading', { name: 'Withdraw', exact: true }),
  ).toBeVisible();
  await expect(main.getByTestId('withdraw-available')).toBeVisible();
  await expect(bankForm(page)).toHaveCount(0);
  await expect(main.getByText(/New accounts can withdraw/)).toHaveCount(0);
});
