import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, signUpRecipient } from './helpers';
import { accountOf, seedBusiness } from './business-fixtures';
import { sql } from './ops-helpers';
import { startStack, type Stack } from './profile-fixtures';

// TipMe for businesses, PR B1: creating a business, its locations and managers. The e2e stack runs
// with BUSINESS_ENABLED=true (playwright.config.ts); the last test uses a stand-in stack with it off.

const apply = async (
  page: Page,
  { name, slug }: { name: string; slug: string },
) => {
  await page.getByLabel('Business name').fill(name);
  await page.getByLabel('Address on TipMe', { exact: true }).fill(slug);
  await page.getByLabel('Location name').fill('Victoria Island');
  await page.getByLabel('Street address').fill('27 Ademola Adetokunbo, Lagos');
  await page.getByRole('button', { name: 'Create business' }).click();
};

test('a person applies for a business and sees it waiting to be verified', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  // From the public page, as the header's "Businesses" choice leads there.
  await page.goto('/for-businesses');
  await page.getByRole('link', { name: 'Create your business' }).click();
  await expect(page).toHaveURL(/\/dashboard\/business\/apply$/);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Create your business' }),
  ).toBeVisible();
  // The contact email is the account's own confirmed address.
  await expect(page.getByLabel('Contact email')).toHaveValue(who.email);
  await page.getByLabel('Business name').fill('Kemi’s Kitchen');
  // The address on TipMe is suggested from the name.
  await expect(
    page.getByLabel('Address on TipMe', { exact: true }),
  ).toHaveValue('kemi-s-kitchen');
  const slug = `kemi-${randomUUID().slice(0, 8)}`;
  await page.getByLabel('Address on TipMe', { exact: true }).fill(slug);
  await page.getByLabel('Location name').fill('Victoria Island');
  await expect(page.getByLabel('Location address on TipMe')).toHaveValue(
    'victoria-island',
  );
  await page.getByLabel('Street address').fill('27 Ademola Adetokunbo, Lagos');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Create business' }).click();

  const done = page.getByTestId('business-applied');
  await expect(done).toContainText(
    'Thanks. TipMe staff will check Kemi’s Kitchen’s name, address and contact.',
  );
  await expect(done).toContainText('Your codes go live once it’s verified.');
  await expectAccessible(page);
  // The dashboard's Business link shows without a reload (desktop; never in the phone's bar).
  if (testInfo.project.name !== 'mobile')
    await expect(
      page
        .getByRole('navigation', { name: 'Dashboard' })
        .getByRole('link', { name: 'Business' }),
    ).toBeVisible();
  await done.getByRole('link', { name: 'Go to your business' }).click();
  await expect(
    page.getByRole('heading', { level: 1, name: 'Kemi’s Kitchen' }),
  ).toBeVisible();
  await expect(page.getByTestId('business-status')).toHaveText(
    'Waiting to be verified',
  );
  await expect(page.getByTestId('business-standing')).toContainText(
    'Your codes go live once it’s verified.',
  );
  await expect(page.getByTestId('business-location')).toContainText(
    `/b/${slug}/victoria-island`,
  );
  // Nothing claims approval: "verified" is TipMe's own check (M10).
  await expect(page.getByRole('main')).not.toContainText(
    /approved|licensed|regulated/i,
  );
  await expectAccessible(page);
});

test('an owner adds a second location and edits its address', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  await seedBusiness({ owner: userId, status: 'pending', name: 'Ada Bakes' });
  await page.goto('/dashboard/business');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Ada Bakes' }),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Add location' }).click();
  await page.getByLabel('Location name').fill('Ikoyi');
  await expect(page.getByLabel('Location address on TipMe')).toHaveValue(
    'ikoyi',
  );
  await page.getByLabel('Street address').fill('5 Bourdillon, Lagos');
  await page.getByRole('button', { name: 'Add location' }).click();
  await expect(page.getByText('Ikoyi is added.')).toBeVisible();
  const ikoyi = page.getByTestId('business-location').filter({
    hasText: 'Ikoyi',
  });
  await expect(ikoyi).toContainText('5 Bourdillon, Lagos');

  await ikoyi.getByRole('button', { name: 'Edit Ikoyi' }).click();
  // While editing, the row holds the form (its text is in the fields), so look on the page.
  await page.getByLabel('Street address').fill('7 Bourdillon, Lagos');
  await page.getByRole('button', { name: 'Save location' }).click();
  await expect(ikoyi).toContainText('7 Bourdillon, Lagos');
  await expectAccessible(page);

  // Closing asks first, and says what happens to the people there.
  await ikoyi.getByRole('button', { name: 'Close Ikoyi' }).click();
  await expect(ikoyi).toContainText(
    'People at Ikoyi stay on your team. The location page stops showing.',
  );
  await ikoyi.getByRole('button', { name: 'Yes, close Ikoyi' }).click();
  await expect(ikoyi).toContainText('Closed');
  await expect(ikoyi.getByRole('button', { name: 'Edit Ikoyi' })).toHaveCount(
    0,
  );
});

test('a slug already taken is refused next to the field', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  const taken = await seedBusiness({ owner: userId, status: 'pending' });
  await page.goto('/dashboard/business/apply');
  await apply(page, { name: 'Another Chilli', slug: taken.slug });
  const field = page.getByLabel('Address on TipMe', { exact: true });
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toBeFocused();
  await expect(page.getByRole('alert').first()).toContainText(
    'That address is taken. Try another.',
  );
  await expectAccessible(page);
  // A free one goes through.
  await field.fill(`${taken.slug}-2`);
  await page.getByRole('button', { name: 'Create business' }).click();
  await expect(page.getByTestId('business-applied')).toBeVisible();
});

test('a location manager sees only their location and no Add location', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  const { userId } = await accountOf(who.email);
  const [ada] = await sql<{ user_id: string }>(
    `SELECT user_id FROM profiles WHERE handle = 'ada'`,
  );
  const business = await seedBusiness({
    owner: ada!.user_id,
    name: 'The Yellow Chilli',
    locations: [
      { slug: 'vi', name: 'Victoria Island' },
      { slug: 'ikoyi', name: 'Ikoyi' },
    ],
  });
  await sql(
    `INSERT INTO business_managers (id, business_id, user_id, role, location_id, added_by)
     VALUES ($1, $2, $3, 'location_manager', $4, $5)`,
    [
      randomUUID(),
      business.businessId,
      userId,
      business.locations[1]!.id,
      ada!.user_id,
    ],
  );
  await page.goto('/dashboard/business');
  await expect(
    page.getByRole('heading', { level: 1, name: 'The Yellow Chilli' }),
  ).toBeVisible();
  const locations = page.getByTestId('business-location');
  await expect(locations).toHaveCount(1);
  await expect(locations).toContainText('Ikoyi');
  await expect(page.getByRole('button', { name: 'Add location' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Close Ikoyi' })).toHaveCount(
    0,
  );
  await expect(page.getByRole('button', { name: 'Edit Ikoyi' })).toBeVisible();
  await expect(
    page.getByText(
      'Only an owner of The Yellow Chilli can change its details.',
    ),
  ).toBeVisible();
  // The managers list: the owner and them; no Remove for a location manager.
  const managers = page.locator('#managers');
  await expect(managers).toContainText('Owner, all locations');
  await expect(managers).toContainText('Manager, Ikoyi');
  await expect(managers.getByRole('button', { name: /^Remove/ })).toHaveCount(
    0,
  );
  await expectAccessible(page);
});

test.describe('with TipMe for businesses off', () => {
  let stack: Stack | undefined;
  test.setTimeout(120_000);
  test.afterAll(async () => {
    await stack?.stop();
  });

  test('the businesses page keeps the coming-soon interest form, and the header says so', async ({
    page,
  }) => {
    // A stand-in API whose /health/release has no `business`: off.
    stack = await startStack('test');
    await page.goto(`${stack.origin}/for-businesses`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'TipMe for businesses is on its way.',
    );
    await expect(
      page.getByRole('link', { name: 'Create your business' }),
    ).toHaveCount(0);
    // A cold stand-in web may not have hydrated yet; a press before then reloads the form.
    await expect(async () => {
      await page.getByLabel('Work email').fill('owner@example.com');
      await page
        .getByRole('button', { name: "Tell me when it's ready" })
        .click();
      // Nothing is sent or stored yet: the card says so and offers the draft.
      await expect(page.getByText('Your email is ready to send.')).toBeVisible({
        timeout: 2_000,
      });
    }).toPass({ timeout: 30_000 });
    const href = await page
      .getByRole('link', { name: 'Open email app' })
      .getAttribute('href');
    expect(href).toContain('mailto:usetipme@gmail.com?');
    expect(decodeURIComponent((href ?? '').replaceAll('+', ' '))).toContain(
      'owner@example.com',
    );
    await expect(page.getByRole('status')).toContainText('press Send');
    const main = page.getByRole('main');
    await expect(main).not.toContainText(
      /₦|\bNGN\b|launch date|\bper month\b/i,
    );
    await expect(main).not.toContainText(/20\d\d/);

    const nav = page.getByRole('navigation', { name: 'Main navigation' });
    const who = nav.getByRole('button', { name: "Who it's for" });
    if (await who.isVisible()) await who.click();
    else await page.getByRole('button', { name: 'Open menu' }).click();
    await expect(
      nav.getByRole('link', { name: /^Businesses \(coming soon\)/ }),
    ).toHaveAttribute('href', '/for-businesses');
    await expectAccessible(page);
  });
});
