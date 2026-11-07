import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signInWithEmail, signUpRecipient } from './helpers';
import { accountOf, seedBusiness } from './business-fixtures';

// TipMe for businesses, PR B3: inviting people (link, username, email), the Work page, and
// leaving. The e2e stack runs with BUSINESS_ENABLED=true (playwright.config.ts).

// Two people sign up in each test, which takes longer than one sign-up's budget.
test.slow();

const nav = (page: Page) => page.getByRole('navigation', { name: 'Dashboard' });

/** Reloads the Business page and waits for its People section (its detail loads after the shell). */
async function reloadPeople(page: Page) {
  await page.reload();
  await expect(
    page.getByRole('heading', { level: 2, name: 'People' }),
  ).toBeVisible({ timeout: 20_000 });
}

async function ownerWithBusiness(
  page: Page,
  testInfo: Parameters<typeof signUpRecipient>[1],
) {
  const owner = await signUpRecipient(page, testInfo);
  const { userId } = await accountOf(owner.email);
  const business = await seedBusiness({ owner: userId });
  await page.goto('/dashboard/business');
  await expect(
    page.getByRole('heading', { level: 2, name: 'People' }),
  ).toBeVisible({ timeout: 20_000 });
  return { owner, business };
}

test('a one-time link: made and shown once, kept through sign-in, accepted on Work, then left', async ({
  page,
  browser,
}, testInfo) => {
  await ownerWithBusiness(page, testInfo);
  await expect(page.getByText('Nobody has joined yet.')).toBeVisible();
  await page
    .getByRole('group', { name: 'How should we reach them?' })
    .getByLabel('Link')
    .check();
  await page.getByRole('button', { name: 'Make a link' }).click();
  const linkField = page.getByRole('textbox', { name: 'Link' });
  await expect(linkField).toBeVisible();
  const link = await linkField.inputValue();
  expect(link).toMatch(/\/dashboard\/work#join=[A-Z2-7]{16}$/);
  await expect(
    page.getByText(
      'This link works once, for 7 days. Anyone who opens it can join, so send it only to them.',
    ),
  ).toBeVisible();
  const share = page.getByRole('link', { name: 'Share on WhatsApp' });
  expect(await share.getAttribute('href')).toContain(encodeURIComponent(link));
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(
    page.getByRole('button', { name: 'Withdraw invitation for One-time link' }),
  ).toBeVisible();

  // Someone with their own TipMe account opens it signed out.
  const context = await browser.newContext();
  const staff = await context.newPage();
  const person = await signUpRecipient(staff, testInfo);
  await context.clearCookies();
  await staff.goto(new URL(link).pathname + new URL(link).hash);
  await staff.waitForURL(/\/sign-in/);
  expect(staff.url()).not.toContain('join');
  await signInWithEmail(staff, person.email);
  await staff.waitForURL(/\/dashboard/);
  // The kept link shows the Work link and is answered there.
  if (testInfo.project.name !== 'mobile')
    await nav(staff).getByRole('link', { name: 'Work' }).click();
  else await staff.goto('/dashboard/work');
  await expect(
    staff.getByText(
      'The Yellow Chilli · Victoria Island invites you to receive tips there.',
    ),
  ).toBeVisible();
  await expect(
    staff.getByText(
      'Your tips go to your own TipMe balance. You can leave at any time.',
    ),
  ).toBeVisible();
  await expectAccessible(staff);
  await staff.getByRole('button', { name: 'Accept' }).click();
  await expect(staff.getByText('You joined The Yellow Chilli.')).toBeVisible();
  await expect(
    staff.getByRole('heading', {
      level: 2,
      name: 'The Yellow Chilli · Victoria Island',
    }),
  ).toBeVisible();

  // How they show there.
  await staff.getByLabel('Shown as').fill('Kemi O.');
  await staff.getByRole('switch', { name: 'Show my photo' }).uncheck();
  await staff.getByRole('button', { name: 'Save' }).click();
  await expect(staff.getByText('Saved.')).toBeVisible();
  await expectAccessible(staff);

  // The owner sees them on the team.
  await reloadPeople(page);
  await expect(
    page.getByRole('button', { name: 'Remove Kemi O.' }),
  ).toBeVisible();

  // Leaving asks first, then is instant.
  await staff.getByRole('button', { name: 'Leave Victoria Island' }).click();
  await expect(
    staff.getByText(
      'You’ll stop showing at Victoria Island straight away. Your tips and balance stay yours.',
    ),
  ).toBeVisible();
  await staff
    .getByRole('button', { name: 'Yes, leave Victoria Island' })
    .click();
  await expect(
    staff.getByText('You don’t work anywhere on TipMe yet.'),
  ).toBeVisible();
  await reloadPeople(page);
  await expect(page.getByText('Nobody has joined yet.')).toBeVisible();
  await context.close();
});

test('by username: the search shows a public card, the person accepts, the owner removes them', async ({
  page,
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const staff = await context.newPage();
  const person = await signUpRecipient(staff, testInfo);
  await ownerWithBusiness(page, testInfo);
  await page
    .getByRole('group', { name: 'How should we reach them?' })
    .getByLabel('TipMe username')
    .check();
  await page.getByLabel('Their TipMe username').fill(person.handle);
  const card = page.getByRole('button', {
    name: new RegExp(`@${person.handle}`),
  });
  await expect(card).toBeVisible();
  await card.click();
  await expect(card).toHaveAttribute('aria-pressed', 'true');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(
    page.getByText(`Invitation sent to @${person.handle}.`, { exact: false }),
  ).toBeVisible();
  await expect(page.getByText(`@${person.handle}`).first()).toBeVisible();

  // The person is told in the app, and answers on Work.
  await staff.goto('/dashboard/work');
  await expect(
    staff.getByText(
      'The Yellow Chilli · Victoria Island invites you to receive tips there.',
    ),
  ).toBeVisible();
  await staff.getByRole('button', { name: 'Accept' }).click();
  await expect(staff.getByText('You joined The Yellow Chilli.')).toBeVisible();

  await reloadPeople(page);
  // In People: B1's Managers card (now real) has its own "Remove …" for the owner.
  const people = page.getByRole('region', { name: 'People' });
  await people.getByRole('button', { name: /^Remove / }).click();
  await people.getByRole('button', { name: /^Yes, remove / }).click();
  await expect(page.getByText(/is no longer on the team\./)).toBeVisible();
  await staff.reload();
  await expect(
    staff.getByText('You don’t work anywhere on TipMe yet.'),
  ).toBeVisible();
  await context.close();
});

test('the invited person can stop a business inviting them, and a page that isn’t live is told to go live', async ({
  page,
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const staff = await context.newPage();
  const person = await signUpRecipient(staff, testInfo, { live: false });
  await ownerWithBusiness(page, testInfo);
  // By email: the invitee's sign-in address is proven, so it reaches their Work page too.
  await page.getByLabel('Their email address').fill(person.email);
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(
    page.getByText(`Invitation sent to ${person.email}.`),
  ).toBeVisible();

  await staff.goto('/dashboard/work');
  await staff.getByRole('button', { name: 'Accept' }).click();
  await expect(
    staff.getByText('Your TipMe page needs to be live first.'),
  ).toBeVisible();
  await expect(
    staff.getByRole('link', { name: 'Go to Settings' }),
  ).toBeVisible();
  await expectAccessible(staff);
  await staff
    .getByRole('button', { name: 'Stop invitations from The Yellow Chilli' })
    .click();
  await expect(
    staff.getByText('The Yellow Chilli can’t invite you any more.'),
  ).toBeVisible();
  await expect(
    staff.getByRole('button', {
      name: 'Allow The Yellow Chilli to invite you again',
    }),
  ).toBeVisible();
  await context.close();
});
