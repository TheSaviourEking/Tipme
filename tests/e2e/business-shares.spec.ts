import { expect, test, type Locator, type Page } from '@playwright/test';
import type { BusinessDetail, MyMembership } from '@tipme/contracts';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness, seedMember } from './business-fixtures';
import { API_ORIGIN } from './stack';

// Business release 2, PR R2-C1: the business proposes a share, the staff member decides on their
// Work page (board section 3). The e2e stack runs with BUSINESS_ENABLED and BUSINESS_SHARES_ENABLED.
//
// The Business page draws its sections once B1's business detail loads, and the Work page its
// cards once B3's `GET /v1/me/work` answers. Neither route is on this branch's base, so this spec
// answers those two reads with the seeded rows; every share call goes to the real API.

async function answerShellReads(
  page: Page,
  detail: BusinessDetail,
  membership: MyMembership,
) {
  await page.route(`${API_ORIGIN}/v1/me/businesses/${detail.id}`, (route) =>
    route.fulfill({ json: { data: detail } }),
  );
  await page.route(`${API_ORIGIN}/v1/me/work`, (route) =>
    route.fulfill({ json: { data: [membership] } }),
  );
}

// The radio sits under its label's face (tm-choice), so a person, and this test, clicks the label.
async function pick(scope: Locator, name: string) {
  await scope.getByText(name, { exact: true }).click();
  await expect(scope.getByRole('radio', { name })).toBeChecked();
}

const shares = (page: Page) =>
  page.getByRole('region', { name: 'Share of tips' });

test('the business proposes, the staff member declines, suggests another split, and reports', async ({
  page,
}, testInfo) => {
  // One journey across both pages, with four accessibility checks: longer than the default.
  test.setTimeout(120_000);
  const who = await signUpRecipient(page, testInfo);
  const { userId, profileId } = await accountOf(who.email);
  const business = await seedBusiness({
    owner: userId,
    name: 'The Yellow Chilli',
  });
  const location = business.locations[0]!;
  // The owner also works there, so one person plays both sides.
  const { memberId } = await seedMember({
    locationId: location.id,
    profileId,
    shownName: 'Kemi',
  });
  await answerShellReads(
    page,
    {
      id: business.businessId,
      slug: business.slug,
      name: 'The Yellow Chilli',
      status: 'verified',
      slugLocked: true,
      contact: { name: 'Funke', email: 'funke@example.com' },
      locations: [
        {
          id: location.id,
          slug: location.slug,
          name: 'Victoria Island',
          address: '27 Ademola Adetokunbo, Lagos',
          closed: false,
        },
      ],
      you: { role: 'owner' },
    },
    {
      memberId,
      business: {
        id: business.businessId,
        name: 'The Yellow Chilli',
        slug: business.slug,
        status: 'verified',
      },
      location: {
        id: location.id,
        name: 'Victoria Island',
        slug: location.slug,
      },
      shownName: 'Kemi',
      showPhoto: true,
      shareAmounts: false,
      onShift: false,
      staffCodePath: `/b/${business.slug}/${location.slug}/${who.handle}`,
    },
  );

  // The business proposes 90/10.
  await page.goto('/dashboard/business');
  await expect(shares(page).getByTestId(`share-${memberId}`)).toContainText(
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
  await expect(shares(page).getByTestId(`share-${memberId}`)).toContainText(
    'Pending: the business takes 10%',
  );
  await expectAccessible(page);

  // The staff member declines; the business reads only "No change".
  await page.goto('/dashboard/work');
  const card = page.getByRole('region', {
    name: 'The Yellow Chilli · Victoria Island',
  });
  await expect(
    card.getByText(
      /The Yellow Chilli asks to keep 10% of the tips you get there/,
    ),
  ).toBeVisible();
  await expect(card.getByText('You keep 90%', { exact: false })).toBeVisible();
  await expectAccessible(page);
  await card.getByRole('button', { name: 'Decline' }).click();
  await expect(card.getByRole('button', { name: 'Decline' })).toHaveCount(0);
  await expect(
    card.getByText('You keep all your tips here.', { exact: true }),
  ).toBeVisible();

  await page.goto('/dashboard/business');
  const row = shares(page).getByTestId(`share-${memberId}`);
  await expect(row).toContainText('No change');
  await expect(row).not.toContainText(/declin/i);

  // Proposed again at 80/20; the staff member suggests 90/10 and the business accepts it.
  await pick(shares(page), '80/20');
  await shares(page).getByRole('button', { name: 'Send to Kemi' }).click();
  await expect(row).toContainText('Pending: the business takes 20%');
  await page.goto('/dashboard/work');
  await card.getByRole('button', { name: 'Suggest another split' }).click();
  await pick(card, '90/10');
  await card.getByRole('button', { name: 'Send to The Yellow Chilli' }).click();
  await expect(
    card.getByText(
      /You suggested keeping 90% from .*Waiting for The Yellow Chilli\./,
    ),
  ).toBeVisible();

  await page.goto('/dashboard/business');
  await expect(row).toContainText('They suggest the business takes 10%');
  await row.getByRole('button', { name: 'Accept Kemi’s split' }).click();
  await expect(row).toContainText('Accepted: the business takes 10%, from');

  // The staff member sees when it starts, and reports the business to TipMe.
  await page.goto('/dashboard/work');
  await expect(card.getByText(/^From .*, you keep 90%\.$/)).toBeVisible();
  await card
    .getByRole('button', { name: 'Report The Yellow Chilli to TipMe' })
    .click();
  await pick(card, 'The share isn’t what we agreed');
  await card.getByLabel('Tell us more (optional)').fill('We agreed on less.');
  await expectAccessible(page);
  await card.getByRole('button', { name: 'Send report' }).click();
  await expect(
    card.getByText(
      'Thanks. TipMe will look into it. The Yellow Chilli isn’t told about your report.',
    ),
  ).toBeVisible();
});
