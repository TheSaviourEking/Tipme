/**
 * Page Studio editor (plan 2026-11-12-page-studio, Task 9, PR G1): the editor's pure parts. Plain
 * TypeScript with no `@/` imports, so its unit test runs in Node (test/studio-editor.test.mjs).
 * Every value the editor writes is a typed choice the document schema accepts; nothing here
 * produces CSS.
 */
import {
  STUDIO_ERROR_RULES,
  STUDIO_FIX_NEEDS_INPUT,
  STUDIO_FONTS,
  STUDIO_WEIGHT,
  contrastRatio,
  isHex,
  type Hex,
  type StudioCheckResult,
  type StudioDocument,
  type StudioFix,
  type StudioFont,
  type StudioFontId,
  type StudioIssue,
  type StudioPalette,
  type StudioRuleId,
} from '@tipme/contracts';

/** What a person typed as a colour, as `#rrggbb` (lower case), or null when it isn't one. */
export function normaliseHex(input: string): Hex | null {
  const raw = input.trim().replace(/^#/, '').toLowerCase();
  const full = /^[0-9a-f]{3}$/.test(raw)
    ? [...raw].map((c) => c + c).join('')
    : raw;
  const hex = `#${full}`;
  return isHex(hex) ? hex : null;
}

/** 15.04 → "15.0 : 1", as the board writes a contrast ratio. */
export const formatRatio = (ratio: number) => `${ratio.toFixed(1)} : 1`;

export interface PaletteChip {
  label: string;
  hex: Hex;
  /** Against the page; null for a surface or a decorative line. */
  ratio: number | null;
  /** The ratio the pair must reach (WCAG AA). */
  min: number;
}

/** The derived colours the Style tab shows, each text-like one with its live ratio on the page. */
export function paletteChips(
  palette: StudioPalette,
  mode: 'light' | 'dark',
): PaletteChip[] {
  const t = palette[mode];
  const on = (hex: Hex) => contrastRatio(hex, t.page);
  return [
    { label: 'Page', hex: t.page, ratio: null, min: 0 },
    { label: 'Card', hex: t.card, ratio: null, min: 0 },
    { label: 'Text', hex: t.text, ratio: on(t.text), min: 4.5 },
    { label: 'Quiet text', hex: t.muted, ratio: on(t.muted), min: 4.5 },
    {
      label: 'Accent',
      hex: t.accent,
      ratio: on(t.accent),
      min: t.accentLarge ? 3 : 4.5,
    },
    { label: 'Lines', hex: t.line, ratio: null, min: 0 },
    { label: 'Links', hex: t.link, ratio: on(t.link), min: 4.5 },
    { label: 'Focus ring', hex: t.focus, ratio: on(t.focus), min: 3 },
  ];
}

/**
 * The design check's colour notes ("Your yellow is too light…"), split into the first sentence,
 * shown bold, and the rest. The check writes the words, so the editor and the check panel agree.
 */
export function colourNotes(
  check: StudioCheckResult,
): { lead: string; rest: string }[] {
  return check.notices
    .filter((n) => n.rule === 'contrast')
    .map((n) => {
      const at = n.message.indexOf('. ');
      return at < 0
        ? { lead: n.message, rest: '' }
        : { lead: n.message.slice(0, at + 1), rest: n.message.slice(at + 2) };
    });
}

/** How a brand colour is used on the page, with the ratio of each use ("As text … not used"). */
export function colourUse(
  palette: StudioPalette,
  mode: 'light' | 'dark',
  index: 0 | 1,
  hex: Hex,
): { label: string; ratio: number; used: boolean }[] {
  const t = palette[mode];
  const second = index === 1 ? t.second : undefined;
  const asText = contrastRatio(hex, t.page);
  return [
    {
      label: 'Buttons',
      ratio: second
        ? contrastRatio(second.onFill, second.fill)
        : contrastRatio(t.buttonText, t.button),
      used: true,
    },
    {
      label: 'Links',
      ratio: contrastRatio(second ? second.text : t.link, t.page),
      used: true,
    },
    { label: 'As text', ratio: asText, used: asText >= 3 },
  ];
}

/** The families that can take a role, in the registry's order. */
export function fontChoices(role: 'heading' | 'body'): StudioFont[] {
  return STUDIO_FONTS.filter((f) => f.roles.includes(role));
}

/**
 * The document with one font slot changed. Picking replaces the slot, so a page never has a third
 * family; a family that can't take the role changes nothing.
 */
export function withFont(
  doc: StudioDocument,
  slot: 'heading' | 'body',
  id: StudioFontId,
): StudioDocument {
  const font = STUDIO_FONTS.find((f) => f.id === id);
  if (!font?.roles.includes(slot)) return doc;
  return { ...doc, fonts: { ...doc.fonts, [slot]: id } };
}

/**
 * The document with its second colour set, or removed (null). A row on the second colour can't
 * exist without one, so removing it moves those rows onto the main colour.
 */
export function withSecondColour(
  doc: StudioDocument,
  hex: Hex | null,
): StudioDocument {
  if (hex) return { ...doc, brand: [doc.brand[0], hex] };
  return {
    ...doc,
    brand: [doc.brand[0]],
    rows: doc.rows.map((row) =>
      row.background === 'second' ? { ...row, background: 'colour' } : row,
    ),
  };
}

/**
 * The check the editor shows: the server's (the authority) while the draft is the one it checked,
 * the editor's own instant check as soon as anything changes.
 */
export function checkShown(
  doc: StudioDocument,
  local: StudioCheckResult,
  server: { doc: string; check: StudioCheckResult } | null,
): StudioCheckResult {
  return server && server.doc === JSON.stringify(doc) ? server.check : local;
}

/** The fixes a button applies in one click. */
export function fixesNow(issue: StudioIssue): StudioFix[] {
  return issue.fixes.filter((f) => !STUDIO_FIX_NEEDS_INPUT.includes(f.id));
}

/** Fixes that need a new photo, link or words: their buttons open the block's form (Blocks tab). */
export function fixesInput(issue: StudioIssue): StudioFix[] {
  return issue.fixes.filter((f) => STUDIO_FIX_NEEDS_INPUT.includes(f.id));
}

const PASSING: Record<
  (typeof STUDIO_ERROR_RULES)[number],
  (doc: StudioDocument, check: StudioCheckResult) => string
> = {
  contrast: () => 'Text is readable (light and dark)',
  'phone-fit': () => 'Fits phones from 320 px',
  'long-word': () => 'Long words fit',
  fonts: (doc) => {
    const n = new Set([doc.fonts.heading, doc.fonts.body]).size;
    return `Fonts: ${n} ${n === 1 ? 'family' : 'families'}`;
  },
  'heading-order': () => 'Headings in order',
  crowded: () => 'Rows not crowded',
  'photo-resolution': () => 'Photos are sharp',
  'photo-alt': () => 'Photos are described',
  'page-weight': (_doc, check) =>
    `Page weight: ${Math.round(check.weightBytes / 1000)} KB of ${STUDIO_WEIGHT.budget / 1_000_000} MB`,
  'empty-block': () => 'No empty blocks',
  'broken-video': () => 'Videos and links work',
};

/** The passing list, in the check's order. */
export function passingWords(
  check: StudioCheckResult,
  doc: StudioDocument,
): string[] {
  return check.passing
    .filter((rule): rule is (typeof STUDIO_ERROR_RULES)[number] =>
      (STUDIO_ERROR_RULES as readonly StudioRuleId[]).includes(rule),
    )
    .map((rule) => PASSING[rule](doc, check));
}

export type SaveState = 'saved' | 'pending' | 'saving' | 'failed';

/**
 * The top bar's line. `published`: false before the first publish, true when the draft differs
 * from the published page, 'same' when it doesn't.
 */
export function saveWords(state: SaveState, published: boolean | 'same') {
  const where =
    published === 'same'
      ? 'Your page shows this design'
      : published
        ? 'Changes not published yet'
        : 'Not published yet';
  const tail =
    state === 'failed'
      ? 'Not saved'
      : state === 'saved'
        ? published === 'same'
          ? ''
          : 'Draft saved'
        : 'Saving…';
  return tail ? `${where} · ${tail}` : where;
}

/**
 * What the dashboard offers, from the answer to `GET /v1/me/studio`: nothing while Page Studio is
 * switched off (404) or the answer failed, the editor for Pro, the Pro teaser for Free, the kept
 * note after Pro ends.
 */
export function studioEntry(answer: {
  status: number;
  access?: 'edit' | 'preview' | 'lapsed';
}): 'edit' | 'pro' | 'lapsed' | null {
  if (answer.status !== 200 || !answer.access) return null;
  return answer.access === 'edit'
    ? 'edit'
    : answer.access === 'lapsed'
      ? 'lapsed'
      : 'pro';
}
