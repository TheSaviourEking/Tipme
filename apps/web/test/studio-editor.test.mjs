import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  STUDIO_STYLE_IDS,
  checkDesign,
  studioDocumentSchema,
} from '@tipme/contracts';
import {
  accentChoices,
  accentHeading,
  accentNote,
  coverChoices,
  proBanner,
  selectedAccent,
  styleCardLabel,
  styleChoosable,
  styleHeading,
  styleSummary,
  withAccent,
  withCover,
  withMode,
  withStyle,
} from '../src/app/dashboard/studio/style-tab-model.ts';
import {
  checkBadge,
  checkShown,
  fixesInput,
  fixesLinks,
  fixesNow,
  issueTab,
  passingWords,
  blockedIntro,
  publishFailureWords,
  publishLabel,
  publishOutcome,
  publishTally,
  saveWords,
  studioEntry,
  withRefusal,
} from '../src/app/dashboard/studio/studio-editor-model.ts';

// Page Studio editor on v2 (styles plan Task 12, PR 4a): the Style tab's pure parts (§10) and
// the editor's (status line, the Check tab's badge, the check's fixes).

const doc = (extra = {}) => ({
  v: 2,
  style: 'clear',
  accent: null,
  mode: 'light',
  cover: 'yours',
  blocks: [
    { id: 'blk00001', kind: 'text', variant: 'heading', text: 'New single' },
    { id: 'blk00002', kind: 'quote', text: 'Sang like home.' },
  ],
  ...extra,
});
const ctx = (extra = {}) => ({
  images: {},
  videos: {},
  profile: { name: 'Kemi Adeyinka', bio: true, links: 3 },
  plan: 'pro',
  coverKind: 'photo',
  hasAvatar: true,
  ...extra,
});
const valid = (d) => studioDocumentSchema.safeParse(d).success;

test('switching style keeps an explicit accent, the mode and the blocks', () => {
  const start = doc({ accent: 'rose', mode: 'dark', cover: 'plain' });
  const next = withStyle(start, 'journal');
  assert.equal(next.style, 'journal');
  assert.equal(next.accent, 'rose');
  assert.equal(next.mode, 'dark');
  assert.equal(next.cover, 'plain', 'Journal offers Plain, so it stays');
  assert.deepEqual(next.blocks, start.blocks);
  assert.ok(valid(next));
  // An accent left at the style's own stays the style's own: each style opens differently.
  assert.equal(withStyle(doc(), 'stage').accent, null);
});

test('switching to a style without the current cover type selects Your cover', () => {
  for (const style of ['signboard', 'sprint']) {
    const next = withStyle(doc({ cover: 'gradient' }), style);
    assert.equal(next.cover, 'yours', style);
    assert.ok(valid(next), style);
  }
  // And a cover the new style offers is kept.
  assert.equal(
    withStyle(doc({ cover: 'gradient' }), 'linen').cover,
    'gradient',
  );
  assert.equal(withStyle(doc({ cover: 'plain' }), 'sprint').cover, 'plain');
});

test('browsing styles keeps the last cover choice: Clear+Gradient → Sprint → Journal restores Gradient', () => {
  // The person chose Gradient on Clear; arrows then pass Sprint (no gradient) on the way to Journal.
  const wanted = 'gradient';
  const clear = doc({ cover: 'gradient' });
  const sprint = withStyle(clear, 'sprint', wanted);
  assert.equal(sprint.cover, 'yours', 'Sprint has no gradient: Your cover');
  assert.ok(valid(sprint));
  const journal = withStyle(sprint, 'journal', wanted);
  assert.equal(journal.cover, 'gradient', 'Journal offers it again: restored');
  assert.ok(valid(journal));
  // Without a remembered choice, the document's own cover is used as before.
  assert.equal(withStyle(sprint, 'journal').cover, 'yours');
});

test('choosing TipMe purple stores no accent', () => {
  const classic = doc({ style: 'classic', accent: 'green' });
  const purple = accentChoices('classic', 'pro')[0];
  assert.equal(purple.name, 'TipMe purple');
  assert.equal(purple.value, null);
  const next = withAccent(classic, purple.value);
  assert.equal(next.accent, null);
  assert.equal(selectedAccent(next), null);
  assert.equal(accentHeading(next), 'TipMe purple');
  // Classic back at every default is exactly a page that never opened the Studio (§9.1).
  assert.deepEqual(
    withAccent(
      { ...classic, blocks: [], mode: 'light', cover: 'yours' },
      purple.value,
    ),
    {
      v: 2,
      style: 'classic',
      accent: null,
      mode: 'light',
      cover: 'yours',
      blocks: [],
    },
  );
});

test('the accent swatches: TipMe purple first on Classic only, the eight, then From your photo', () => {
  const names = (style) => accentChoices(style, 'pro').map((a) => a.name);
  const eight = [
    'Ink',
    'Blue',
    'Lagoon',
    'Green',
    'Violet',
    'Rose',
    'Coral',
    'Amber',
  ];
  assert.deepEqual(names('classic'), [
    'TipMe purple',
    ...eight,
    'From your photo',
  ]);
  assert.deepEqual(names('clear'), [...eight, 'From your photo']);
  // A style's own accent shows selected while nothing is picked (Clear's is Blue).
  assert.equal(selectedAccent(doc()), 'blue');
  assert.equal(accentHeading(doc()), 'Blue');
  assert.equal(accentHeading(doc({ accent: 'photo' })), 'From your photo');
  assert.equal(withAccent(doc(), 'amber').accent, 'amber');
});

test('card labels: "Clear, Quiet, bright, precise. Free." and Classic adds "The default."', () => {
  assert.equal(styleCardLabel('clear'), 'Clear, Quiet, bright, precise. Free.');
  assert.equal(
    styleCardLabel('stage'),
    'Stage, House lights down, spotlight up. Pro.',
  );
  assert.equal(
    styleCardLabel('classic'),
    'Classic, Today’s TipMe page, unchanged. Free. The default.',
  );
  for (const id of STUDIO_STYLE_IDS)
    assert.match(styleCardLabel(id), /^[A-Z][a-z]+, .+\. (Free|Pro)\./, id);
});

test('the heading reads "4 of 9 free" on Free and "9 styles" on Pro', () => {
  assert.equal(styleHeading('free'), '4 of 9 free');
  assert.equal(styleHeading('pro'), '9 styles');
  assert.equal(
    proBanner(),
    'Stage, Signboard, Sprint, Tiles and Horizon come with Pro.',
  );
});

test('Free can’t choose a Pro style yet (R5); a style the draft already holds stays selectable', () => {
  assert.equal(styleChoosable('stage', 'free', doc()), false);
  assert.equal(styleChoosable('journal', 'free', doc()), true);
  assert.equal(styleChoosable('stage', 'pro', doc()), true);
  // A lapsed draft that holds Stage keeps it chosen (§11: a held Pro item saves).
  assert.equal(styleChoosable('stage', 'free', doc({ style: 'stage' })), true);
});

test('Free sees the photo swatch disabled with "“From your photo” comes with Pro."', () => {
  const photo = (plan, hasAvatar = true) =>
    accentChoices('clear', plan, hasAvatar).at(-1);
  assert.equal(photo('free').name, 'From your photo');
  assert.equal(photo('free').disabled, true);
  assert.equal(
    accentNote(doc(), { plan: 'free', hasAvatar: true, photoAccent: null }),
    '“From your photo” comes with Pro.',
  );
  // Pro with no profile photo: disabled, with the reason (§6).
  assert.equal(photo('pro', false).disabled, true);
  assert.equal(
    accentNote(doc(), { plan: 'pro', hasAvatar: false, photoAccent: null }),
    'Add a profile photo to use this.',
  );
  // Pro with a photo: chosen, it says where the colour comes from, and why a fallback is used.
  assert.equal(photo('pro').disabled, false);
  assert.equal(
    accentNote(doc({ accent: 'photo' }), {
      plan: 'pro',
      hasAvatar: true,
      photoAccent: null,
    }),
    'Picked from your profile photo and checked for contrast in light and dark.',
  );
  assert.equal(
    accentNote(doc({ accent: 'photo' }), {
      plan: 'pro',
      hasAvatar: true,
      photoAccent: { failed: true, fallback: 'green' },
    }),
    'Picked from your profile photo and checked for contrast in light and dark. Your photo’s colours didn’t pass our contrast check, so your page uses Green.'.replace(
      /’/g,
      "'",
    ),
  );
  assert.equal(
    accentNote(doc(), { plan: 'pro', hasAvatar: true, photoAccent: null }),
    null,
    'nothing to say for a curated accent',
  );
});

test('the Cover control shows Your cover and Plain only for Signboard and Sprint', () => {
  const labels = (style) => coverChoices(style).map((c) => c.label);
  assert.deepEqual(labels('signboard'), ['Your cover', 'Plain']);
  assert.deepEqual(labels('sprint'), ['Your cover', 'Plain']);
  for (const style of ['classic', 'clear', 'stage', 'horizon'])
    assert.deepEqual(labels(style), ['Your cover', 'Gradient', 'Plain']);
  assert.equal(withCover(doc(), 'plain').cover, 'plain');
  assert.equal(withMode(doc(), 'auto').mode, 'auto');
});

test('the summary reads "Clear · Blue · Auto · Your cover · 5 blocks"', () => {
  assert.equal(
    styleSummary(doc({ mode: 'auto' }), 5),
    'Clear · Blue · Auto · Your cover · 5 blocks',
  );
  assert.equal(
    styleSummary(doc({ style: 'classic', cover: 'plain' }), 1),
    'Classic · TipMe purple · Light · Plain · 1 block',
  );
  assert.equal(
    styleSummary(doc({ accent: 'photo', mode: 'dark' }), 0),
    'Clear · From your photo · Dark · Your cover · 0 blocks',
  );
});

test('the shown check is the server’s for the document it checked, the editor’s otherwise', () => {
  const d = doc();
  const local = checkDesign(d, ctx());
  const server = { ...local, weightBytes: 1 };
  assert.equal(
    checkShown(d, local, { doc: JSON.stringify(d), check: server }),
    server,
  );
  assert.equal(
    checkShown(doc({ mode: 'dark' }), local, {
      doc: JSON.stringify(d),
      check: server,
    }),
    local,
  );
  assert.equal(checkShown(d, local, null), local);
});

test('the Check tab’s badge reads "Pass" or "N to fix"', () => {
  assert.equal(checkBadge(0), 'Pass');
  assert.equal(checkBadge(1), '1 to fix');
  assert.equal(checkBadge(3), '3 to fix');
});

test('a Pro style on Free is a page-level issue the Style tab answers; its fixes are placed', () => {
  const check = checkDesign(
    doc({ style: 'stage', accent: 'photo' }),
    ctx({ plan: 'free' }),
  );
  const style = check.issues.find((i) => i.at.row === 'style');
  const accent = check.issues.find((i) => i.at.row === 'accent');
  assert.ok(style && accent);
  assert.equal(issueTab(style), 'style');
  assert.equal(issueTab(accent), 'style');
  assert.deepEqual(
    fixesInput(style).map((f) => f.id),
    ['choose-free-style'],
  );
  assert.deepEqual(
    fixesLinks(style).map((f) => f.id),
    ['see-pro'],
  );
  assert.deepEqual(
    fixesNow(accent).map((f) => f.id),
    ['use-default-accent'],
  );
  assert.equal(issueTab({ at: { row: '', block: 'blk00001' } }), 'blocks');
});

test('every rule has words in the passing list', () => {
  const check = checkDesign(doc(), ctx());
  const words = passingWords(check);
  assert.equal(words.length, check.passing.length);
  assert.ok(words.every((w) => typeof w === 'string' && w.length > 0));
  assert.ok(words.includes('Long words fit'));
});

test('the button reads "Publish · 2 to fix" while issues remain and "Publish" when the check passes', () => {
  assert.equal(publishLabel(2), 'Publish · 2 to fix');
  assert.equal(publishLabel(1), 'Publish · 1 to fix');
  assert.equal(publishLabel(0), 'Publish');
  // The count is the check's: two empty quotes are two issues.
  const check = checkDesign(
    doc({
      blocks: [
        { id: 'blk00001', kind: 'quote', text: '' },
        { id: 'blk00002', kind: 'quote', text: '' },
      ],
    }),
    ctx(),
  );
  assert.equal(publishLabel(check.issues.length), 'Publish · 2 to fix');
});

test('the publish dialog reads "Design check: N of N pass" over the rules that can block', () => {
  const check = checkDesign(doc(), ctx());
  assert.equal(check.issues.length, 0);
  assert.match(publishTally(check), /^Design check: (\d+) of \1 pass$/);
  assert.equal(publishTally(check), 'Design check: 7 of 7 pass');
  const failing = checkDesign(
    doc({ blocks: [{ id: 'blk00001', kind: 'quote', text: '' }] }),
    ctx(),
  );
  assert.equal(publishTally(failing), 'Design check: 6 of 7 pass');
});

test('after a 422 the server’s issues replace the client’s until the next edit', () => {
  const d = doc();
  const local = checkDesign(d, ctx());
  const issue = {
    rule: 'long-word',
    severity: 'error',
    at: { row: '', block: 'blk00001' },
    message: 'A word is too long for a phone',
    fixes: [],
  };
  const refused = { doc: JSON.stringify(d), issues: [issue] };
  const shown = withRefusal(d, local, refused);
  assert.deepEqual(shown.issues, [issue]);
  assert.ok(!shown.passing.includes('long-word'));
  // The next edit: the editor's own check again.
  assert.equal(withRefusal(doc({ mode: 'dark' }), local, refused), local);
  assert.equal(withRefusal(d, local, null), local);
});

test('a publish answer becomes an outcome: published, the server’s issues, or why it failed', () => {
  const issue = {
    rule: 'long-word',
    severity: 'error',
    at: { row: '', block: 'blk00001' },
    message: 'A word is too long for a phone',
    fixes: [],
  };
  assert.equal(publishOutcome({ ok: true, status: 200, data: {} }), 'published');
  assert.deepEqual(
    publishOutcome({
      ok: false,
      status: 422,
      code: 'STUDIO_DESIGN_CHECK_FAILED',
      issues: [issue],
    }),
    { issues: [issue] },
  );
  // A 422 without issues is no refusal to list: it failed.
  for (const issues of [undefined, []])
    assert.deepEqual(
      publishOutcome({
        ok: false,
        status: 422,
        code: 'STUDIO_DESIGN_CHECK_FAILED',
        ...(issues ? { issues } : {}),
      }),
      { failed: 'other' },
    );
  assert.deepEqual(
    publishOutcome({ ok: false, status: 0, code: 'NETWORK' }),
    { failed: 'network' },
  );
  assert.deepEqual(
    publishOutcome({ ok: false, status: 409, code: 'STUDIO_DRAFT_STALE' }),
    { failed: 'stale' },
  );
  assert.deepEqual(
    publishOutcome({ ok: false, status: 404, code: 'NOT_FOUND' }),
    { failed: 'unavailable' },
  );
  assert.deepEqual(
    publishOutcome({ ok: false, status: 500, code: 'INTERNAL_ERROR' }),
    { failed: 'other' },
  );
});

test('a failed publish says why, never claims a network failure didn’t publish, and offers a retry only when Publish works', () => {
  assert.equal(
    publishFailureWords('network', true),
    'We couldn’t confirm it was published. Check your connection, then reload to see.',
  );
  assert.doesNotMatch(publishFailureWords('network', true), /wasn’t published/);
  assert.equal(
    publishFailureWords('stale', false),
    'This draft changed in another tab. Show the latest to keep editing.',
  );
  assert.equal(
    publishFailureWords('unavailable', true),
    'Page Studio isn’t available right now.',
  );
  assert.equal(
    publishFailureWords('other', true),
    'Your page wasn’t published. Try again in a moment.',
  );
  assert.equal(
    publishFailureWords('other', false),
    'Your page wasn’t published.',
  );
  for (const reason of ['network', 'stale', 'unavailable'])
    assert.doesNotMatch(publishFailureWords(reason, false), /try again/i);
});

test('the list’s intro says the draft is saved only when it is', () => {
  assert.equal(
    blockedIntro(2, 'saved'),
    '2 things to fix first. Your draft is saved.',
  );
  assert.equal(
    blockedIntro(1, 'saved'),
    '1 thing to fix first. Your draft is saved.',
  );
  for (const state of ['pending', 'saving', 'failed'])
    assert.equal(blockedIntro(2, state), '2 things to fix first.');
});

test('the status line says where the draft is ("Saved · not published")', () => {
  assert.equal(saveWords('saved', false), 'Saved · not published');
  assert.equal(saveWords('saved', true), 'Saved · not published');
  assert.equal(saveWords('saved', 'same'), 'Published');
  assert.equal(saveWords('pending', false), 'Saving…');
  assert.equal(saveWords('saving', 'same'), 'Saving…');
  assert.equal(saveWords('failed', true), 'Not saved');
});

test('the dashboard entry: hidden while the switch is off; every page opens the editor', () => {
  assert.equal(studioEntry({ status: 404 }), null);
  assert.equal(studioEntry({ status: 500 }), null);
  assert.equal(studioEntry({ status: 200, access: 'edit' }), 'edit');
});

test('the editor never writes markup from text, and names no payment provider', () => {
  const dir = new URL('../src/app/dashboard/studio/', import.meta.url);
  for (const file of readdirSync(dir).filter((f) => /\.(tsx?|css)$/.test(f))) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(source, /dangerouslySetInnerHTML/, file);
    assert.doesNotMatch(source, /paystack|flutterwave|monnify|bachs/i, file);
    assert.doesNotMatch(source, /@handle\b/, file);
  }
});

test('the renderer the preview uses has no server-only imports', () => {
  const dir = new URL('../src/components/studio-styles/', import.meta.url);
  for (const file of readdirSync(dir).filter(
    (f) => f.endsWith('.tsx') || f.endsWith('.ts'),
  )) {
    const source = readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(
      source,
      /from '(server-only|next\/headers|next\/server|node:[a-z]+)'/,
      file,
    );
  }
});
