import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, fitsViewport, signUpRecipient } from './helpers';
import { sql } from './ops-helpers';
import { API_ORIGIN, WEB_ORIGIN } from './stack';

// Page Studio undo and discard (styles plan Task 15, PR 5b; spec §12.2–12.3, R4). Undo is in the
// header, named for what it undoes, and Ctrl/Cmd+Z works outside text fields; undo saves like any
// change. "Discard changes" asks once, then the draft is the published page (or Classic with no
// blocks) and undo is empty. A Free (lapsed) undo that would re-add a Pro block saved away this
// session is refused by the server, and the editor keeps it undone and says why. The
// `page_studio` switch is on in the e2e stack.

const headers = { origin: WEB_ORIGIN, 'x-tipme-csrf': '1' };

// Sign-up, saves and the public page's revalidation take a while on a busy machine.
test.describe.configure({ timeout: 120_000 });

async function setPlan(handle: string, plan: 'pro' | 'free') {
  await sql(
    `UPDATE profiles SET staff_pro = $2, plan = $3 WHERE handle_lower = $1`,
    [handle, plan === 'pro', plan],
  );
}

async function savedStudio(page: Page) {
  const mine = await page.request.get(`${API_ORIGIN}/v1/me/studio`);
  expect(mine.status()).toBe(200);
  return (await mine.json()).data;
}

async function saveDraft(page: Page, draft: Record<string, unknown>) {
  const mine = await savedStudio(page);
  const saved = await page.request.put(`${API_ORIGIN}/v1/me/studio/draft`, {
    headers,
    data: { rev: mine.rev, draft: { ...mine.draft, ...draft } },
  });
  expect(saved.status(), await saved.text()).toBe(200);
}

async function publishNow(page: Page) {
  const mine = await savedStudio(page);
  const published = await page.request.post(
    `${API_ORIGIN}/v1/me/studio/publish`,
    { headers, data: { rev: mine.rev } },
  );
  expect(published.status(), await published.text()).toBe(200);
}

const HEADING = {
  id: 'e2eund01',
  kind: 'text',
  variant: 'heading',
  text: 'New single',
};
const QUOTE = { id: 'e2eund02', kind: 'quote', text: 'Sang like home.' };
const PARAGRAPH = {
  id: 'e2eund03',
  kind: 'text',
  variant: 'paragraph',
  text: 'Out on Friday.',
};
const GALLERY = { id: 'e2eund04', kind: 'gallery', images: [] };

const bar = (page: Page) => page.locator('.pst-bar');
const undoButton = (page: Page) =>
  bar(page).getByRole('button', { name: /^Undo/ });
const discardButton = (page: Page) =>
  bar(page).getByRole('button', { name: 'Discard changes' });
const discardDialog = (page: Page) =>
  page.getByRole('dialog', { name: 'Discard your changes?' });
const card = (page: Page, name: string) =>
  page
    .getByRole('radiogroup', { name: 'Style', exact: true })
    .getByRole('radio', { name: new RegExp(`^${name},`) });
const blockList = (page: Page) =>
  page.getByRole('list', { name: 'Your blocks' });
const readOnlyBanner = (page: Page) => page.locator('.pst-banner');

async function openEditor(page: Page) {
  await page.goto('/dashboard/studio');
  await expect(
    page.getByRole('heading', { name: 'Page Studio', level: 1 }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(undoButton(page)).toBeVisible();
}

async function openBlocks(page: Page) {
  await page.getByRole('tab', { name: 'Blocks' }).click();
  await expect(page.getByRole('heading', { name: 'Blocks' })).toBeVisible();
}

/** Waits until the API holds a draft that passes `check`. */
async function savedWhere(
  page: Page,
  check: (draft: Record<string, unknown>) => boolean,
) {
  await expect
    .poll(async () => check((await savedStudio(page)).draft), {
      timeout: 15_000,
    })
    .toBe(true);
}

const blockIds = (draft: Record<string, unknown>) =>
  (draft.blocks as { id: string }[]).map((b) => b.id).join(',');

test('Undo restores the previous style and saves it', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'journal', blocks: [HEADING] });
  await openEditor(page);
  // Nothing to undo yet: named plainly, aria-disabled but focusable.
  await expect(undoButton(page)).toHaveAccessibleName('Undo');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');

  await card(page, 'Clear').click();
  await savedWhere(page, (d) => d.style === 'clear');
  const undo = bar(page).getByRole('button', {
    name: 'Undo: style changed to Clear',
  });
  await expect(undo).toBeVisible();
  await expect(undo).toHaveText('Undo');
  await undo.click();

  await expect(card(page, 'Journal')).toHaveAttribute('aria-checked', 'true');
  await savedWhere(page, (d) => d.style === 'journal');
  await expect(bar(page).getByRole('status')).toHaveText(
    'Saved · not published',
  );
  await expect(undoButton(page)).toHaveAccessibleName('Undo');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  // Focus stays on Undo (aria-disabled, never disabled, so it isn't lost to the page).
  await expect(undoButton(page)).toBeFocused();
});

test('Ctrl+Z undoes outside a text field and types normally inside one', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'journal', blocks: [HEADING] });
  await openEditor(page);
  await card(page, 'Clear').click();
  await savedWhere(page, (d) => d.style === 'clear');

  await openBlocks(page);
  await blockList(page).getByRole('button', { name: /^Text/ }).click();
  const field = blockList(page).getByRole('textbox', {
    name: 'Heading',
    exact: true,
  });
  await field.focus();
  // Inside a text field the keys are the field's own: the editor's undo doesn't run.
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.type('!');
  await expect(field).toHaveValue('New single!');
  await savedWhere(
    page,
    (d) =>
      d.style === 'clear' &&
      (d.blocks as { text?: string }[])[0]?.text === 'New single!',
  );
  await expect(undoButton(page)).toHaveAccessibleName('Undo: heading edited');

  // Outside a field, it is the editor's Undo, one step at a time.
  await page.getByRole('tab', { name: 'Blocks' }).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(field).toHaveValue('New single');
  await expect(undoButton(page)).toHaveAccessibleName(
    'Undo: style changed to Clear',
  );
  await page.keyboard.press('ControlOrMeta+z');
  await savedWhere(
    page,
    (d) =>
      d.style === 'journal' &&
      (d.blocks as { text?: string }[])[0]?.text === 'New single',
  );
  await expect(undoButton(page)).toHaveAccessibleName('Undo');
});

test('Discard asks once, "Discard your changes? Your page stays as it is now.", with "Discard changes" and "Keep editing"; afterwards the draft equals the published page and undo is empty', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo);
  await saveDraft(page, {
    style: 'clear',
    blocks: [HEADING, QUOTE, PARAGRAPH],
  });
  await publishNow(page);
  await saveDraft(page, { style: 'journal', blocks: [HEADING] });
  await openEditor(page);
  await card(page, 'Linen').click();
  await savedWhere(page, (d) => d.style === 'linen');
  await expect(undoButton(page)).toHaveAccessibleName(
    'Undo: style changed to Linen',
  );

  const trigger = discardButton(page);
  await trigger.click();
  const dialog = discardDialog(page);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleDescription(
    'Your page stays as it is now.',
  );
  // Starts on the safe answer, so a stray Enter keeps the work.
  const keep = dialog.getByRole('button', { name: 'Keep editing' });
  await expect(keep).toBeFocused();
  await keep.click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect((await savedStudio(page)).draft.style).toBe('linen');

  await trigger.click();
  await discardDialog(page)
    .getByRole('button', { name: 'Discard changes' })
    .click();
  await expect(discardDialog(page)).toHaveCount(0);
  // Asked once: no second question.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(card(page, 'Clear')).toHaveAttribute('aria-checked', 'true');
  await expect(bar(page).getByRole('status')).toHaveText('Published');
  const after = await savedStudio(page);
  expect(after.draft).toEqual(after.published);
  await expect(undoButton(page)).toHaveAccessibleName('Undo');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  // Nothing left to discard.
  await expect(trigger).toHaveAttribute('aria-disabled', 'true');
});

test('discarding a never-published page leaves Classic with no blocks', async ({
  page,
}, testInfo) => {
  await signUpRecipient(page, testInfo, { live: false });
  await saveDraft(page, { style: 'clear', accent: 'rose', blocks: [QUOTE] });
  await openEditor(page);
  await discardButton(page).click();
  await discardDialog(page)
    .getByRole('button', { name: 'Discard changes' })
    .click();
  await expect(discardDialog(page)).toHaveCount(0);
  await expect(card(page, 'Classic')).toHaveAttribute('aria-checked', 'true');
  const after = await savedStudio(page);
  expect(after.published).toBeNull();
  expect(after.draft).toMatchObject({
    v: 2,
    style: 'classic',
    accent: null,
    mode: 'light',
    cover: 'yours',
    blocks: [],
  });
  await openBlocks(page);
  await expect(page.getByText('No blocks yet. Add one below.')).toBeVisible();
});

test('undo of a saved-away Pro block on Free stays undone and says why', async ({
  page,
}, testInfo) => {
  // A lapsed draft: saved on Pro with a gallery that was never published.
  const who = await signUpRecipient(page, testInfo, { live: false });
  await setPlan(who.handle, 'pro');
  await saveDraft(page, { style: 'clear', blocks: [HEADING, GALLERY] });
  await setPlan(who.handle, 'free');
  await openEditor(page);
  await openBlocks(page);
  await blockList(page).getByRole('button', { name: 'Remove Gallery' }).click();
  await savedWhere(page, (d) => blockIds(d) === HEADING.id);

  const undo = bar(page).getByRole('button', {
    name: 'Undo: block removed',
  });
  await undo.click();
  // The server refuses the gallery (403): the step stays undone, and the editor says why.
  await expect(
    page.getByText('Adding this back needs Pro. Everything else is kept.'),
  ).toBeVisible({ timeout: 15_000 });
  await expect(
    blockList(page).getByRole('button', { name: 'Remove Gallery' }),
  ).toHaveCount(0);
  const after = await savedStudio(page);
  expect(blockIds(after.draft)).toBe(HEADING.id);
  expect(after.draft.style).toBe('clear');
  // Not read-only: everything else still saves.
  await expect(readOnlyBanner(page)).toHaveCount(0);
  await blockList(page).getByRole('button', { name: /^Text/ }).click();
  await blockList(page)
    .getByRole('textbox', { name: 'Heading', exact: true })
    .fill('Kept');
  await savedWhere(
    page,
    (d) => (d.blocks as { text?: string }[])[0]?.text === 'Kept',
  );
  // The next change takes the sentence away.
  await expect(
    page.getByText('Adding this back needs Pro. Everything else is kept.'),
  ).toHaveCount(0);
});

test('a lapsed draft can still be reordered, edited and undone', async ({
  page,
}, testInfo) => {
  // §14.6, the editor half: Stage and a gallery saved on Pro, now Free.
  const who = await signUpRecipient(page, testInfo, { live: false });
  await setPlan(who.handle, 'pro');
  await saveDraft(page, { style: 'stage', blocks: [HEADING, GALLERY, QUOTE] });
  await setPlan(who.handle, 'free');
  await openEditor(page);
  await openBlocks(page);

  await blockList(page).getByRole('button', { name: 'Move Quote up' }).click();
  await savedWhere(
    page,
    (d) => blockIds(d) === [HEADING.id, QUOTE.id, GALLERY.id].join(','),
  );
  await blockList(page).getByRole('button', { name: /^Text/ }).click();
  await blockList(page)
    .getByRole('textbox', { name: 'Heading', exact: true })
    .fill('Lapsed but here');
  await savedWhere(
    page,
    (d) => (d.blocks as { text?: string }[])[0]?.text === 'Lapsed but here',
  );

  await bar(page).getByRole('button', { name: 'Undo: heading edited' }).click();
  await savedWhere(
    page,
    (d) => (d.blocks as { text?: string }[])[0]?.text === 'New single',
  );
  await bar(page).getByRole('button', { name: 'Undo: block moved' }).click();
  await savedWhere(
    page,
    (d) =>
      d.style === 'stage' &&
      blockIds(d) === [HEADING.id, GALLERY.id, QUOTE.id].join(','),
  );
  await expect(readOnlyBanner(page)).toHaveCount(0);
  await expect(
    page.getByText('Adding this back needs Pro. Everything else is kept.'),
  ).toHaveCount(0);
});

for (const width of [320, 1440])
  test(`axe is clean with Undo and the discard dialog at ${width}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    await signUpRecipient(page, testInfo, { live: false });
    await saveDraft(page, { style: 'clear', blocks: [HEADING] });
    await openEditor(page);
    await card(page, 'Journal').click();
    await expect(undoButton(page)).toHaveAccessibleName(
      'Undo: style changed to Journal',
    );
    await expectAccessible(page);
    expect(await fitsViewport(page)).toBe(true);
    await discardButton(page).click();
    await expect(discardDialog(page)).toBeVisible();
    await expectAccessible(page);
    expect(await fitsViewport(page)).toBe(true);
  });
