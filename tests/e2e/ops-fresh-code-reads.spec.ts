import { expect, test } from '@playwright/test';
import { expectAccessible } from './helpers';
import { codeFor, codeWentStale, enrolOwner } from './ops-helpers';

// Screens that only read still need a fresh code (the audit log, the people list). With a stale
// code they ask for one and then load; turned down, they say a code is needed, never "your role".

const SCREENS = [
  {
    path: '/ops/audit',
    heading: 'Audit log',
    loaded: (page: import('@playwright/test').Page) =>
      page.getByRole('region', { name: 'Audit entries' }),
    problem: 'Couldn’t load the audit log',
  },
  {
    path: '/ops/staff/people',
    heading: 'Staff members',
    loaded: (page: import('@playwright/test').Page) =>
      page.getByRole('main').locator('.ops-list article').first(),
    problem: 'Couldn’t load the people',
  },
];

for (const screen of SCREENS) {
  test(`${screen.path} asks for a fresh code, then loads, and says so honestly when turned down`, async ({
    page,
  }, testInfo) => {
    const owner = await enrolOwner(page, testInfo);
    await codeWentStale(owner);
    await page.goto(screen.path);

    const prompt = page.getByRole('dialog', { name: 'Enter a fresh code' });
    await expect(prompt).toBeVisible();
    await expectAccessible(page);

    // Turned down: a code is needed, and the owner is not told the role lacks it.
    await prompt.getByRole('button', { name: 'Not now' }).click();
    const main = page.getByRole('main');
    await expect(main.getByText(/fresh authenticator code/)).toBeVisible();
    await expect(main.getByText(/role may not include/)).toHaveCount(0);

    // Offered again: the code, then the data.
    await main.getByRole('button', { name: 'Enter a code' }).click();
    await prompt.getByLabel('Authenticator code').fill(await codeFor(owner));
    await prompt.getByRole('button', { name: 'Continue' }).click();
    await expect(prompt).toHaveCount(0);
    await expect(screen.loaded(page)).toBeVisible();
    await expect(main.getByText(screen.problem)).toHaveCount(0);
  });
}
