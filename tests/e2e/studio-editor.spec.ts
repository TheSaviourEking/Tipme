import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Page Studio editor, PR G1 (plan 2026-11-12-page-studio, Task 9a): the way in from My page, the
// shell, the Style tab and the design check. The `page_studio` switch is on in the e2e stack
// (playwright.config.ts); "off" is the API's own answer while it is off, a 404 on every Studio
// route (its API tests prove the 404), played here so nothing else in the run changes.

const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };

async function makePro(handle: string) {
  await sql(
    `UPDATE profiles SET staff_pro = true, plan = 'pro' WHERE handle_lower = $1`,
    [handle],
  );
}

/** The saved draft, as the API holds it. */
async function savedDraft(page: Page) {
  const mine = await page.request.get(`${API_ORIGIN}/v1/me/studio`);
  expect(mine.status()).toBe(200);
  return (await mine.json()).data;
}

const studioCard = (page: Page) => page.locator('#page-studio');

test('G1: with Page Studio switched off, My page has no way in and the editor says it isn’t open', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.route(`${API_ORIGIN}/v1/me/studio`, (route) =>
    route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'NOT_FOUND' } }),
    }),
  );
  await page.goto('/dashboard/settings');
  await expect(page.getByRole('heading', { name: 'About you' })).toBeVisible();
  await expect(studioCard(page)).toHaveCount(0);
  await page.goto('/dashboard/studio');
  await expect(
    page.getByRole('heading', { name: 'Page Studio isn’t open yet' }),
  ).toBeVisible();
  await expect(page.getByRole('tablist')).toHaveCount(0);
});

test('G1: Free sees what Page Studio is and that it comes with Pro @mobile', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  const card = studioCard(page);
  await expect(
    card.getByRole('heading', { name: 'Page Studio (Pro)' }),
  ).toBeVisible();
  await expect(card.getByRole('link', { name: 'See Pro' })).toHaveAttribute(
    'href',
    '/pro',
  );
  await expect(
    card.getByRole('link', { name: 'Design your page' }),
  ).toHaveCount(0);
  // The editor's address gives the same honest answer, and writes nothing.
  await page.goto('/dashboard/studio');
  await expect(
    page.locator('.pst-gate').getByText('Page Studio comes with Pro'),
  ).toBeVisible();
  await expect(
    page.locator('.pst-gate').getByRole('link', { name: 'See Pro' }),
  ).toBeVisible();
  expect(await fitsViewport(page)).toBe(true);
});

test('G1: Pro opens the editor from My page; a colour updates the preview and saves the draft', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await page.goto('/dashboard/settings');
  await studioCard(page)
    .getByRole('link', { name: 'Design your page' })
    .click();
  await page.waitForURL(/\/dashboard\/studio$/);
  await expect(
    page.getByRole('heading', { name: 'Page Studio', level: 1 }),
  ).toBeVisible();
  const preview = page.locator('.pst-preview .studio');
  await expect(preview).toBeVisible();
  const button = () =>
    preview.evaluate((el) =>
      (el as HTMLElement).style.getPropertyValue('--studio-l-button'),
    );
  const before = await button();

  await page.getByLabel('Main colour', { exact: true }).fill('#0F766E');
  await expect.poll(button).not.toBe(before);
  expect(await button()).toBe('#0f766e');
  await expect(
    page.getByRole('status').filter({ hasText: 'Draft saved' }),
  ).toBeVisible();
  expect((await savedDraft(page)).draft.brand).toEqual(['#0f766e']);

  // A typed code that isn't a colour is refused in plain words, and nothing is saved.
  await page.getByLabel('Main colour', { exact: true }).fill('#12');
  await page.getByLabel('Main colour', { exact: true }).blur();
  await expect(page.getByText('Use a colour code like #7A32F9')).toBeVisible();
  expect((await savedDraft(page)).draft.brand).toEqual(['#0f766e']);

  // Mode, fonts, text size and corners are saved too; picking a font replaces its slot.
  await page.getByRole('button', { name: 'Dark page' }).click();
  await page.getByLabel(/Headings/).selectOption('space-grotesk');
  await page.getByRole('button', { name: 'Roomy' }).click();
  await page.getByRole('button', { name: 'Round' }).click();
  await expect(preview).toHaveAttribute('data-mode', 'dark');
  await expect(preview).toHaveAttribute('data-corners', 'round');
  await expect(page.getByText('Fonts · 2 of 2 families')).toBeVisible();
  await expect
    .poll(async () => {
      const d = (await savedDraft(page)).draft;
      return [d.mode, d.fonts.heading, d.scale, d.corners].join(' ');
    })
    .toBe('dark space-grotesk roomy round');
  await expect(
    page.getByText('Made from your colours · dark page'),
  ).toBeVisible();
});

test('G1: a picked yellow shows the accent-only note and passing chips @mobile', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await page.goto('/dashboard/studio');
  await page.getByLabel('Main colour', { exact: true }).fill('#f5c400');
  await expect(
    page.getByText('Your yellow is too light for text on a light page.'),
  ).toBeVisible();
  await expect(
    page.getByText(
      'We’ll use it for highlights and for buttons with dark text, and a deeper shade of it for links and headings. Your page will still look yellow.',
    ),
  ).toBeVisible();
  const use = page.locator('.pst-use');
  await expect(use.getByText(/, not used$/)).toBeVisible();
  // Every text chip passes: text and links at 4.5 to 1 or more.
  for (const label of ['Text', 'Quiet text', 'Links']) {
    const ratio = await page
      .locator('.pst-chip', { has: page.getByText(label, { exact: true }) })
      .locator('span')
      .textContent();
    expect(Number(ratio?.split(' ')[0]), label).toBeGreaterThanOrEqual(4.5);
  }
  expect(await fitsViewport(page)).toBe(true);
  await page.setViewportSize({ width: 320, height: 800 });
  expect(await fitsViewport(page)).toBe(true);
});

/** A photo of `size` px a side, made in the browser and uploaded as the person. */
async function uploadPhoto(page: Page, size: number): Promise<string> {
  return page.evaluate(
    async ({ api, size }) => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#2878c8';
      g.fillRect(0, 0, size, size);
      g.fillStyle = '#f5c400';
      g.fillRect(size / 10, size / 10, size / 3, size / 3);
      const blob = await new Promise<Blob>((done) =>
        canvas.toBlob((b) => done(b!), 'image/jpeg', 0.9),
      );
      const response = await fetch(`${api}/v1/me/studio/images`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'image/jpeg', 'x-tipme-csrf': '1' },
        body: blob,
      });
      if (response.status !== 201)
        throw new Error(`upload: ${response.status} ${await response.text()}`);
      return (await response.json()).meta.imageId as string;
    },
    { api: API_ORIGIN, size },
  );
}

test('G1: the check panel shows a low-res photo issue and its fix clears it', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await page.goto('/dashboard/settings');
  const imageId = await uploadPhoto(page, 640);
  const mine = await savedDraft(page);
  const saved = await page.request.put(`${API_ORIGIN}/v1/me/studio/draft`, {
    headers,
    data: {
      rev: mine.rev,
      draft: {
        ...mine.draft,
        rows: [
          {
            id: 'e2erow01',
            columns: '1',
            spacing: 'm',
            background: 'page',
            cells: [
              [
                {
                  id: 'e2eblk01',
                  kind: 'photo',
                  variant: 'square',
                  imageId,
                  alt: 'Studio night, Yaba',
                },
              ],
            ],
          },
        ],
      },
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);

  await page.goto('/dashboard/studio');
  const check = page.getByRole('complementary', { name: 'Design check' });
  await expect(check.getByText('1 to fix before publishing')).toBeVisible();
  await expect(check.getByText('A photo will look blurry')).toBeVisible();
  await expect(
    page.getByRole('tab', { name: /Check\s*1 to fix/ }),
  ).toBeVisible();
  // Desktop: the Style tab, the preview and the check beside it, with an issue showing.
  await expectAccessible(page);
  await check.getByRole('button', { name: 'Make the photo smaller' }).click();
  await expect(check.getByText('Every check passes')).toBeVisible();
  await expect(check.getByText('A photo will look blurry')).toHaveCount(0);
  await expect(check.getByText('Photos are sharp')).toBeVisible();
  // Focus lands on the count, not on the page's top, once the issue and its button are gone.
  await expect(check.getByText('Every check passes')).toBeFocused();
  // The fix is a document change like any other: saved, and the server agrees.
  await expect
    .poll(async () => (await savedDraft(page)).draft.rows[0].columns)
    .toBe('1-1');
  expect((await savedDraft(page)).check.issues).toEqual([]);
});

test('G1: the editor works by keyboard and passes axe on each tab @mobile', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await makePro(who.handle);
  await page.goto('/dashboard/studio');
  const style = page.getByRole('tab', { name: 'Style' });
  await expect(style).toHaveAttribute('aria-selected', 'true');
  await expectAccessible(page);
  await style.focus();
  // G2 put Blocks between Style and Check; End jumps to the last tab.
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: 'Blocks' })).toBeFocused();
  await page.keyboard.press('End');
  const checkTab = page.getByRole('tab', { name: /^Check/ });
  await expect(checkTab).toBeFocused();
  await expect(checkTab).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('tabpanel').getByRole('heading', { name: 'Design check' }),
  ).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press('Home');
  await expect(style).toBeFocused();
  // The segmented choices are buttons that say which one is on.
  await page.getByRole('button', { name: 'Compact' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Compact' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // The preview is a picture: nothing in it takes focus.
  expect(
    await page
      .locator('.pst-preview a, .pst-preview button')
      .evaluateAll((els) => els.filter((el) => !el.closest('[inert]')).length),
  ).toBe(0);
});
