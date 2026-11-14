import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { codeFor, enrolOwner, secondOwner, sql } from './ops-helpers';

// Feature switches in admin (owner, 14 Nov 2026; docs/runbooks/settings-and-switches.md): an owner
// turns a feature off and it disappears without a deploy; a money switch waits for a second person.

const REASON = 'Agreed with the owner on the call today';

/** Back to the start, written directly: the API copies catch up within the 15-second cache. */
const restore = (key: string, on: boolean) =>
  sql(
    `UPDATE feature_switches SET enabled = $2, source = 'staff' WHERE key = $1`,
    [key, on],
  );

const switchCard = (page: Page, key: string) =>
  page.getByRole('main').getByTestId(`switch-${key}`);

// @alone: a switch changes the feature for every page, so nothing may run beside it.
test('@alone an owner turns OnlyFans and Fansly links off and a Pro page’s editor shows them hidden', async ({
  page,
  browser,
}, testInfo) => {
  // A Pro recipient with an OnlyFans link (written directly: the link editor is tested elsewhere).
  const who = await signUpRecipient(page, testInfo);
  await sql(
    `UPDATE profiles SET plan = 'pro', links = $2::jsonb WHERE handle = $1`,
    [
      who.handle,
      JSON.stringify([
        { platform: 'onlyfans', url: `https://onlyfans.com/${who.handle}` },
      ]),
    ],
  );
  const hidden = page.getByText(
    'Not showing on your page right now. It stays saved.',
  );
  await page.goto('/dashboard/settings');
  await expect(
    page.getByRole('heading', { name: 'Your links', level: 3 }),
  ).toBeVisible();
  await expect(hidden).toHaveCount(0);

  const staff = await (
    await browser.newContext({
      baseURL: testInfo.project.use.baseURL,
      reducedMotion: 'reduce',
    })
  ).newPage();
  try {
    await enrolOwner(staff, testInfo);
    await staff.goto('/ops/switches');
    await expect(
      staff.getByRole('main').getByRole('heading', { name: 'Switches' }),
    ).toBeVisible();
    const card = switchCard(staff, 'adult_platform_links');
    await expect(card.getByTestId('switch-state')).toContainText('On');
    await card
      .getByRole('button', { name: 'Turn OnlyFans and Fansly links off…' })
      .click();
    await card
      .getByLabel('Why turn OnlyFans and Fansly links off?')
      .fill(REASON);
    await expectAccessible(staff);
    await card.getByRole('button', { name: 'Turn off', exact: true }).click();
    await expect(card.getByTestId('switch-state')).toContainText('Off');
    await expect(card.getByText(REASON).first()).toBeVisible();

    // The feature disappears for the recipient, with no deploy.
    await page.reload();
    await expect(hidden).toBeVisible();

    // And comes back.
    await card
      .getByRole('button', { name: 'Turn OnlyFans and Fansly links on…' })
      .click();
    await card
      .getByLabel('Why turn OnlyFans and Fansly links on?')
      .fill(REASON);
    await card.getByRole('button', { name: 'Turn on', exact: true }).click();
    await expect(card.getByTestId('switch-state')).toContainText('On');
    await page.reload();
    await expect(
      page.getByRole('heading', { name: 'Your links', level: 3 }),
    ).toBeVisible();
    await expect(hidden).toHaveCount(0);
  } finally {
    await restore('adult_platform_links', true);
    await staff.context().close();
  }
});

test('@alone a money switch waits for a second person, and changes once they approve', async ({
  page,
  browser,
}, testInfo) => {
  await enrolOwner(page, testInfo);
  const second = await secondOwner(browser, testInfo);
  try {
    await page.goto('/ops/switches');
    const card = switchCard(page, 'pro_refunds');
    await expect(card.getByTestId('switch-state')).toContainText('Off');
    await expect(card.getByText('Money', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Turn Pro refunds on…' }).click();
    await card.getByLabel('Why turn Pro refunds on?').fill(REASON);
    await card.getByRole('button', { name: 'Ask for approval' }).click();
    await expect(
      card.getByText('Waiting for a second person', { exact: true }).first(),
    ).toBeVisible({ timeout: 15_000 });
    // Nothing changed yet.
    await page.reload();
    await expect(card.getByTestId('switch-state')).toContainText('Off');

    await second.page.goto('/ops/approvals');
    const request = second.page
      .getByRole('article')
      .filter({ hasText: 'Turn Pro refunds on' });
    await request.getByRole('button', { name: 'Approve…' }).click();
    await request.getByLabel('Authenticator code').fill(await codeFor(second));
    await request.getByRole('button', { name: 'Approve and run' }).click();
    await expect(request).toHaveCount(0);

    await page.reload();
    await expect(card.getByTestId('switch-state')).toContainText('On');
    await card.getByText('History', { exact: true }).click();
    await expect(card.getByRole('listitem').first()).toContainText(
      'approved by',
    );
    await expectAccessible(page);
    await page.setViewportSize({ width: 320, height: 720 });
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await restore('pro_refunds', false);
    await second.context.close();
  }
});
