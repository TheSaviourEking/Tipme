import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Page Studio editor on v2 (styles plan Task 12, PR 4a; spec §10): the Style tab. Every page edits:
// Free picks the free styles and Pro all eleven, with an accent, an appearance and a cover type, and
// the preview (the real renderer, in its own frame) follows. Free sees the Pro styles marked and
// can choose them as a preview that isn't saved (§12.4; studio-free-preview.spec.ts). The
// `page_studio` switch is on in the e2e stack; "off" is the API's own 404, played here so nothing
// else in the run changes.

const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };

// Sign-up and saves take a while on a busy machine; the steps wait on end states.
test.describe.configure({ timeout: 90_000 });

async function setPlan(handle: string, plan: 'pro' | 'free') {
  await sql(
    `UPDATE profiles SET staff_pro = $2, plan = $3 WHERE handle_lower = $1`,
    [handle, plan === 'pro', plan],
  );
}

/** The saved draft, as the API holds it. */
async function savedDraft(page: Page) {
  const mine = await page.request.get(`${API_ORIGIN}/v1/me/studio`);
  expect(mine.status()).toBe(200);
  return (await mine.json()).data;
}

async function saveDraft(page: Page, draft: Record<string, unknown>) {
  const mine = await savedDraft(page);
  const saved = await page.request.put(`${API_ORIGIN}/v1/me/studio/draft`, {
    headers,
    data: { rev: mine.rev, draft: { ...mine.draft, ...draft } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

const studioCard = (page: Page) => page.locator('#page-studio');
const cards = (page: Page) =>
  page.getByRole('radiogroup', { name: 'Style', exact: true });
const card = (page: Page, name: string) =>
  cards(page).getByRole('radio', { name: new RegExp(`^${name},`) });
const swatch = (page: Page, name: string) =>
  page
    .getByRole('radiogroup', { name: /^Accent/ })
    .getByRole('radio', { name, exact: true });
const choice = (page: Page, group: string, name: string) =>
  page
    .getByRole('radiogroup', { name: group, exact: true })
    .getByRole('radio', { name, exact: true });
/** The page inside the preview frame. */
const previewPage = (page: Page) =>
  page.frameLocator('iframe[title="Preview of your page"]').locator('.studio');
/** The saved draft's fields, polled until the debounced save has landed. */
const savedSoon = (
  page: Page,
  pick: (draft: Record<string, unknown>) => unknown,
) =>
  expect.poll(async () => pick((await savedDraft(page)).draft), {
    timeout: 10_000,
  });

async function openEditor(page: Page) {
  await page.goto('/dashboard/studio');
  await expect(
    page.getByRole('heading', { name: 'Page Studio', level: 1 }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(cards(page)).toBeVisible();
}

test('with Page Studio switched off, My page has no way in and the editor says it isn’t open', async ({
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

test('a Pro person picks Stage, Rose and Dark, and the preview shows it', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await setPlan(who.handle, 'pro');
  await page.goto('/dashboard/settings');
  await studioCard(page)
    .getByRole('link', { name: 'Design your page' })
    .click();
  await page.waitForURL(/\/dashboard\/studio$/);
  await expect(cards(page)).toBeVisible();
  // Pro: every card can be chosen, and none says PRO.
  await expect(page.getByText('11 styles')).toBeVisible();
  await expect(cards(page).getByText('PRO', { exact: true })).toHaveCount(0);
  await expect(card(page, 'Classic')).toHaveAttribute('aria-checked', 'true');

  await card(page, 'Stage').click();
  await swatch(page, 'Rose').click();
  await choice(page, 'Appearance', 'Dark').click();
  await expect(card(page, 'Stage')).toHaveAttribute('aria-checked', 'true');
  await expect(swatch(page, 'Rose')).toHaveAttribute('aria-checked', 'true');
  await expect(
    page.locator('.pst-section__head').filter({ hasText: 'Accent' }),
  ).toContainText('Rose');

  // The frame is a picture: hidden from screen readers, out of the Tab order, described in text.
  const frame = page.locator('iframe[title="Preview of your page"]').first();
  await expect(frame).toHaveAttribute('aria-hidden', 'true');
  await expect(frame).toHaveAttribute('tabindex', '-1');
  await expect(page.locator('.pst-frame .sr-only').first()).toHaveText(
    'Preview of your page',
  );
  const shown = previewPage(page);
  await expect(shown).toHaveAttribute('data-style', 'stage');
  await expect(shown).toHaveAttribute('data-mode', 'dark');
  await expect
    .poll(() =>
      shown.evaluate((el) =>
        (el as HTMLElement).style.getPropertyValue('--studio-acc'),
      ),
    )
    .toBe('#ff8db8');
  await savedSoon(page, (d) => [
    d.v,
    d.style,
    d.accent,
    d.mode,
    d.cover,
  ]).toEqual([2, 'stage', 'rose', 'dark', 'yours']);
  await expect(page.locator('.pst-bar').getByRole('status')).toHaveText(
    'Saved · not published',
  );
});

test('a Free person picks Journal and Green and it saves @mobile', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await page.goto('/dashboard/settings');
  await studioCard(page)
    .getByRole('link', { name: 'Design your page' })
    .click();
  await expect(cards(page)).toBeVisible();
  await expect(page.getByText('4 of 11 free')).toBeVisible();
  // Green is Journal's own accent, so it is chosen on Classic first: a picked accent stays picked
  // across styles (§10), where Journal's own would be stored as no accent at all.
  await swatch(page, 'Green').click();
  await card(page, 'Journal').click();
  await expect(swatch(page, 'Green')).toHaveAttribute('aria-checked', 'true');
  await expect(previewPage(page)).toHaveAttribute('data-style', 'journal');
  await savedSoon(page, (d) => [d.style, d.accent]).toEqual([
    'journal',
    'green',
  ]);
  expect(await fitsViewport(page)).toBe(true);
});

test('Free sees PRO on seven cards, the banner "PRO · Stage, Signboard, Sprint, Tiles, Horizon, Creator and Professional come with Pro.", and can choose them to preview', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openEditor(page);
  await expect(cards(page).getByText('PRO', { exact: true })).toHaveCount(7);
  const banner = page.getByRole('link', {
    name: 'PRO · Stage, Signboard, Sprint, Tiles, Horizon, Creator and Professional come with Pro.',
  });
  await expect(banner).toHaveAttribute('href', '/pro');
  // Every card is a real radio, Pro ones included (§12.4 overrides the canvas's aria-disabled).
  for (const name of [
    'Stage',
    'Signboard',
    'Sprint',
    'Tiles',
    'Horizon',
    'Creator',
    'Professional',
    'Clear',
  ])
    await expect(card(page, name)).not.toHaveAttribute('aria-disabled', 'true');
  // The label says what the card is: "{Name}, {mood}. {Free|Pro}." (Classic adds the default).
  await expect(card(page, 'Clear')).toHaveAccessibleName(
    'Clear, Quiet, bright, precise. Free.',
  );
  await expect(card(page, 'Classic')).toHaveAccessibleName(
    'Classic, Today’s TipMe page, unchanged. Free. The default.',
  );

  // A click on a Pro card chooses it (a preview); arrow keys choose each card in turn and never
  // leave the group.
  await card(page, 'Stage').click();
  await expect(card(page, 'Stage')).toHaveAttribute('aria-checked', 'true');
  await card(page, 'Classic').click();
  await expect(card(page, 'Classic')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Clear')).toBeFocused();
  await expect(card(page, 'Clear')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Journal')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Stage')).toBeFocused();
  await expect(card(page, 'Stage')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('End');
  await expect(card(page, 'Professional')).toBeFocused();
  await expect(card(page, 'Professional')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Classic')).toBeFocused();
  await expect(card(page, 'Classic')).toHaveAttribute('aria-checked', 'true');

  // The photo accent is Pro too.
  await expect(swatch(page, 'From your photo')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(
    page.getByText('“From your photo” comes with Pro.'),
  ).toBeVisible();
  await savedSoon(page, (d) => d.style).toBe('classic');
});

test('choosing TipMe purple stores no accent', async ({ page }, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openEditor(page);
  await expect(swatch(page, 'TipMe purple')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await swatch(page, 'Coral').click();
  await savedSoon(page, (d) => d.accent).toBe('coral');
  // Arrow keys move along the swatches and choose; they never leave the group.
  await swatch(page, 'Coral').focus();
  await page.keyboard.press('Home');
  await expect(swatch(page, 'TipMe purple')).toBeFocused();
  await expect(swatch(page, 'TipMe purple')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await savedSoon(page, (d) => d.accent).toBeNull();
});

test('the Cover control shows Your cover and Plain only for Signboard and Sprint, with "Change your cover in Settings." linking to the setting', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await setPlan(who.handle, 'pro');
  await openEditor(page);
  const cover = page.getByRole('radiogroup', { name: 'Cover', exact: true });
  await expect(cover.getByRole('radio')).toHaveText([
    'Your cover',
    'Gradient',
    'Plain',
  ]);
  await choice(page, 'Cover', 'Gradient').click();
  for (const name of ['Signboard', 'Sprint']) {
    await card(page, name).click();
    await expect(cover.getByRole('radio')).toHaveText(['Your cover', 'Plain']);
    // A style without the gradient selects Your cover (Review Focus 5).
    await expect(choice(page, 'Cover', 'Your cover')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await card(page, 'Clear').click();
    await choice(page, 'Cover', 'Gradient').click();
  }
  // Arrow keys choose as they move: passing Sprint (no gradient) must not lose the Gradient choice.
  await card(page, 'Clear').focus();
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowRight');
  await expect(card(page, 'Sprint')).toHaveAttribute('aria-checked', 'true');
  await expect(choice(page, 'Cover', 'Your cover')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowLeft');
  await expect(card(page, 'Journal')).toHaveAttribute('aria-checked', 'true');
  await expect(choice(page, 'Cover', 'Gradient')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await card(page, 'Clear').click();
  await expect(
    page.getByRole('link', { name: 'Change your cover in Settings.' }),
  ).toHaveAttribute('href', '/dashboard/settings#cover');
  await savedSoon(page, (d) => [d.style, d.cover]).toEqual([
    'clear',
    'gradient',
  ]);
});

test('Stage on a non-photo cover shows "Stage looks best with a cover photo. Add one in Settings."', async ({
  page,
}, testInfo) => {
  // A new page's cover is the automatic one, not a photo.
  const who = await signUpRecipient(page, testInfo, { live: false });
  await setPlan(who.handle, 'pro');
  await openEditor(page);
  const notice = page.getByText(
    'Stage looks best with a cover photo. Add one in Settings.',
  );
  await expect(notice).toHaveCount(0);
  await card(page, 'Stage').click();
  await expect(
    page
      .getByRole('tabpanel')
      .getByText('Stage looks best with a cover photo. Add one in Settings.'),
  ).toBeVisible();
  await card(page, 'Clear').click();
  await expect(notice).toHaveCount(0);
});

test('a refused save puts back the draft as it was last saved', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await openEditor(page);
  const frame = page.frameLocator('iframe[title="Preview of your page"]');
  // Classic with every default: today's page in the preview.
  await expect(frame.locator('.profile-page')).toBeVisible({ timeout: 20_000 });
  // The server refuses the next save as needing Pro (as for a plan that changed meanwhile).
  await page.route(`${API_ORIGIN}/v1/me/studio/draft`, (route) =>
    route.request().method() === 'PUT'
      ? route.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'STUDIO_PRO_REQUIRED' } }),
        })
      : route.continue(),
  );
  await card(page, 'Journal').click();
  await expect(page.getByText('That change needs Pro')).toBeVisible({
    timeout: 15_000,
  });
  // The screen matches "kept as it was last saved": Classic again, in the cards and the preview.
  await expect(card(page, 'Classic')).toHaveAttribute('aria-checked', 'true');
  await expect(card(page, 'Journal')).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('.pst-stage__name')).toHaveText('Classic');
  await expect(frame.locator('.profile-page')).toBeVisible();
  await expect(frame.locator('.studio')).toHaveCount(0);
  expect((await savedDraft(page)).draft.style).toBe('classic');
});

test('a lapsed draft with a Pro style shows the issue on the Check tab; “Choose a free style” opens the cards', async ({
  page,
}, testInfo) => {
  const who = await signUpRecipient(page, testInfo, { live: false });
  await setPlan(who.handle, 'pro');
  await saveDraft(page, { style: 'tiles' });
  await setPlan(who.handle, 'free');
  await openEditor(page);
  const tab = page.getByRole('tab', { name: /^Check/ });
  await expect(tab).toContainText('1 to fix');
  // The draft keeps its style; the other Pro cards can be previewed (§12.4).
  await expect(card(page, 'Tiles')).toHaveAttribute('aria-checked', 'true');
  await expect(card(page, 'Stage')).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await tab.click();
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('Tiles is a Pro style')).toBeVisible();
  await expect(panel.getByRole('link', { name: 'See Pro' })).toHaveAttribute(
    'href',
    '/pro',
  );
  await panel.getByRole('button', { name: 'Choose a free style' }).click();
  await expect(card(page, 'Tiles')).toBeFocused();
  // Left through the Pro cards (each a preview, never saved) to Journal, which saves.
  for (let i = 0; i < 4; i += 1) await page.keyboard.press('ArrowLeft');
  await expect(card(page, 'Journal')).toBeFocused();
  await expect(card(page, 'Journal')).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('tab', { name: /^Check/ })).toContainText('Pass');
  await savedSoon(page, (d) => d.style).toBe('journal');
});

for (const width of [390, 1440])
  test(`axe is clean on the Style and Blocks tabs at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const who = await signUpRecipient(page, testInfo, { live: false });
    await setPlan(who.handle, 'pro');
    await saveDraft(page, {
      style: 'clear',
      blocks: [
        { id: 'e2eaxe01', kind: 'text', variant: 'heading', text: 'Hello' },
        { id: 'e2eaxe02', kind: 'quote', text: 'Sang like home.' },
      ],
    });
    await openEditor(page);
    await expect(previewPage(page)).toBeVisible();
    await expectAccessible(page);
    expect(await fitsViewport(page)).toBe(true);
    await page.getByRole('tab', { name: 'Blocks' }).click();
    await expect(
      page.getByRole('list', { name: 'Your blocks' }).getByRole('listitem'),
    ).toHaveCount(2);
    await expectAccessible(page);
    expect(await fitsViewport(page)).toBe(true);
  });
