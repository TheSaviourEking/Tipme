import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';

// Business release 2, PR R2-C1: the business proposes a share, the staff member decides on their
// Work page (board section 3). The e2e stack runs with BUSINESS_ENABLED and BUSINESS_SHARES_ENABLED.
// Every read and every share call goes to the real API (B1's detail and B3's Work list included).

// The radio sits under its label's face (tm-choice), so a person, and this test, clicks the label.
async function pick(scope: Locator, name: string) {
  await scope.getByText(name, { exact: true }).click();
  await expect(scope.getByRole('radio', { name })).toBeChecked();
}

const shares = (page: Page) =>
  page.getByRole('region', { name: 'Share of tips' });

test('the business proposes; a decline stays pending until the start date; a suggestion shows at once', async ({
  page,
}, testInfo) => {
  // One journey across both pages, with four accessibility checks: longer than the default.
  test.setTimeout(120_000);
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({
    owner: userId,
    name: 'The Yellow Chilli',
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'lekki', name: 'Lekki' },
    ],
  });
  const [vi, lekki] = [business.locations[0]!, business.locations[1]!];
  // The owner also works at both locations, so one person plays both sides.
  const { memberId: atVi } = await seedMember({
    locationId: vi.id,
    profileId,
    shownName: 'Kemi',
  });
  const { memberId: atLekki } = await seedMember({
    locationId: lekki.id,
    profileId,
    shownName: 'Kemi L',
  });

  const viRow = shares(page).getByTestId(`share-${atVi}`);
  const lekkiRow = shares(page).getByTestId(`share-${atLekki}`);
  const viCard = page.getByRole('region', {
    name: 'The Yellow Chilli · Victoria Island',
  });
  const lekkiCard = page.getByRole('region', {
    name: 'The Yellow Chilli · Lekki',
  });

  // The business proposes 90/10 at Victoria Island and 80/20 at Lekki.
  await page.goto('/dashboard/business');
  await expect(viRow).toContainText(
    'No change: they keep all their tips here.',
  );
  await pick(shares(page), '90/10');
  await shares(page).getByLabel('To').selectOption({ label: 'Kemi' });
  await expect(
    shares(page).getByText(/^From: \d{1,2} \w+ \d{4}$/),
  ).toBeVisible();
  await shares(page).getByRole('button', { name: 'Send to Kemi' }).click();
  await expect(
    shares(page).getByText('Sent to Kemi. Nothing changes unless they accept.'),
  ).toBeVisible();
  await expect(viRow).toContainText('Proposed: the business takes 10% from');
  await pick(shares(page), '80/20');
  await shares(page).getByLabel('To').selectOption({ label: 'Kemi L' });
  await shares(page).getByRole('button', { name: 'Send to Kemi L' }).click();
  await expect(lekkiRow).toContainText('Proposed: the business takes 20% from');
  await expectAccessible(page);

  // At Victoria Island the staff member declines.
  await page.goto('/dashboard/work');
  await expect(
    viCard.getByText(
      /The Yellow Chilli asks to keep 10% of the tips you get there/,
    ),
  ).toBeVisible();
  await expect(
    viCard.getByText('You keep 90%', { exact: false }),
  ).toBeVisible();
  await expectAccessible(page);
  await viCard.getByRole('button', { name: 'Decline' }).click();
  await expect(viCard.getByRole('button', { name: 'Decline' })).toHaveCount(0);
  await expect(
    viCard.getByText('You keep all your tips here.', { exact: true }),
  ).toBeVisible();

  // At Lekki they suggest 90/10 instead.
  await lekkiCard
    .getByRole('button', { name: 'Suggest another split' })
    .click();
  await pick(lekkiCard, '90/10');
  await lekkiCard
    .getByRole('button', { name: 'Send to The Yellow Chilli' })
    .click();
  await expect(
    lekkiCard.getByText(
      /You suggested keeping 90% from .*Waiting for The Yellow Chilli\./,
    ),
  ).toBeVisible();

  // The business still reads its declined proposal as proposed; the suggestion shows at once.
  await page.goto('/dashboard/business');
  await expect(viRow).toContainText('Proposed: the business takes 10% from');
  await expect(viRow).not.toContainText(/declin|no change/i);
  await expect(lekkiRow).toContainText('They suggest the business takes 10%');
  await lekkiRow.getByRole('button', { name: 'Accept Kemi L’s split' }).click();
  await expect(lekkiRow).toContainText(
    'Accepted: the business takes 10%, from',
  );

  // The staff member sees when it starts, and reports the business to TipMe.
  await page.goto('/dashboard/work');
  await expect(lekkiCard.getByText(/^From .*, you keep 90%\.$/)).toBeVisible();
  await viCard
    .getByRole('button', { name: 'Report The Yellow Chilli to TipMe' })
    .click();
  await pick(viCard, 'The share isn’t what we agreed');
  await viCard.getByLabel('Tell us more (optional)').fill('We agreed on less.');
  await expectAccessible(page);
  await viCard.getByRole('button', { name: 'Send report' }).click();
  await expect(
    viCard.getByText(
      'Thanks. TipMe will look into it. The Yellow Chilli isn’t told about your report.',
    ),
  ).toBeVisible();
});
