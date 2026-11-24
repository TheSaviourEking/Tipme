/**
 * Page Studio's Style tab (styles spec §10; plan Task 12, PR 4a): its pure parts. Plain TypeScript
 * with no `@/` imports, so its unit test runs in Node (test/studio-editor.test.mjs). Every function
 * returns a document the strict schema accepts: a style, an accent id (or null for the style's
 * own), a mode and a cover type. Nothing here produces CSS.
 */
import {
  CLASSIC_PURPLE,
  STUDIO_ACCENTS,
  STUDIO_ACCENT_IDS,
  STUDIO_FREE_STYLES,
  STUDIO_STYLES,
  STUDIO_STYLE_IDS,
  photoAccentNotice,
  type PhotoAccentFailed,
  type PhotoAccentValues,
  type StudioAccentId,
  type StudioCoverType,
  type StudioCuratedAccentId,
  type StudioDocument,
  type StudioMode,
  type StudioStyleId,
} from '@tipme/contracts';

type Plan = 'free' | 'pro';
type PhotoAccent = PhotoAccentValues | PhotoAccentFailed | null;

/** "From your photo" (§6). */
export const PHOTO_ACCENT_NAME = 'From your photo';

/**
 * The document in another style (§10, "Switching style keeps everything the new style can use"):
 * an explicit accent, the mode and the blocks stay. The cover type is the person's last explicit
 * choice (`wanted`, kept by the editor outside the document) when the new style offers it, else the
 * document's when it does, else Your cover (Review Focus 5). So arrowing past Signboard or Sprint
 * (no gradient) never loses a Gradient choice: the next style that offers it gets it back. An accent
 * left at the style's own (null) stays null, so each style opens in its own colour.
 */
export function withStyle(
  doc: StudioDocument,
  style: StudioStyleId,
  wanted?: StudioCoverType,
): StudioDocument {
  const offered = STUDIO_STYLES[style].covers;
  const cover =
    wanted && offered.includes(wanted)
      ? wanted
      : offered.includes(doc.cover)
        ? doc.cover
        : 'yours';
  return { ...doc, style, cover };
}

/** The document with this accent; null is the style's own (TipMe purple on Classic, §9.1). */
export function withAccent(
  doc: StudioDocument,
  accent: StudioAccentId | null,
): StudioDocument {
  return { ...doc, accent };
}

export const withMode = (
  doc: StudioDocument,
  mode: StudioMode,
): StudioDocument => ({ ...doc, mode });

export const withCover = (
  doc: StudioDocument,
  cover: StudioCoverType,
): StudioDocument => ({ ...doc, cover });

/** One accent swatch. `value` null is TipMe purple (Classic's own, stored as no accent). */
export interface AccentChoice {
  value: StudioAccentId | null;
  /** The swatch's accessible name. */
  name: string;
  /** The fill drawn (light mode); null for the photo swatch, which is drawn as a cone. */
  fill: string | null;
  /** aria-disabled: Free, or Pro without a profile photo. */
  disabled: boolean;
}

/**
 * The swatches in order (§10.3): TipMe purple first on Classic only (owner, 17 Nov), the eight
 * curated accents, then "From your photo", which is Pro and needs a profile photo.
 */
export function accentChoices(
  style: StudioStyleId,
  plan: Plan,
  hasAvatar = true,
): AccentChoice[] {
  const curated = STUDIO_ACCENT_IDS.filter(
    (id): id is StudioCuratedAccentId => id !== 'photo',
  ).map((id) => ({
    value: id,
    name: STUDIO_ACCENTS[id].name,
    fill: STUDIO_ACCENTS[id].light.fill,
    disabled: false,
  }));
  return [
    ...(style === 'classic'
      ? [
          {
            value: null,
            name: CLASSIC_PURPLE.name,
            fill: CLASSIC_PURPLE.light.fill,
            disabled: false,
          },
        ]
      : []),
    ...curated,
    {
      value: 'photo',
      name: PHOTO_ACCENT_NAME,
      fill: null,
      disabled: plan !== 'pro' || !hasAvatar,
    },
  ];
}

/**
 * The swatch shown selected: the stored accent, or the style's own while none is picked. Null is
 * TipMe purple (Classic).
 */
export function selectedAccent(doc: StudioDocument): StudioAccentId | null {
  return doc.accent ?? STUDIO_STYLES[doc.style].defaultAccent;
}

/** The accent's name, after "Accent" (§10.3). */
export function accentHeading(doc: StudioDocument): string {
  const id = selectedAccent(doc);
  if (id === null) return CLASSIC_PURPLE.name;
  if (id === 'photo') return PHOTO_ACCENT_NAME;
  return STUDIO_ACCENTS[id].name;
}

/** The line under the swatches, or null when there is nothing to say (§6, §10.3). */
export function accentNote(
  doc: StudioDocument,
  facts: { plan: Plan; hasAvatar: boolean; photoAccent: PhotoAccent },
): string | null {
  if (facts.plan !== 'pro') return '“From your photo” comes with Pro.';
  if (!facts.hasAvatar) return 'Add a profile photo to use this.';
  if (doc.accent !== 'photo') return null;
  const picked =
    'Picked from your profile photo and checked for contrast in light and dark.';
  const notice = photoAccentNotice(facts.photoAccent);
  return notice ? `${picked} ${notice}` : picked;
}

/** "Clear, Quiet, bright, precise. Free." (the card's accessible name); Classic adds "The default." */
export function styleCardLabel(style: StudioStyleId): string {
  const s = STUDIO_STYLES[style];
  const plan = s.plan === 'pro' ? 'Pro' : 'Free';
  return `${s.name}, ${s.mood}. ${plan}.${style === 'classic' ? ' The default.' : ''}`;
}

/** Beside "Style": "4 of 9 free" on Free, "9 styles" on Pro (§10.2). */
export function styleHeading(plan: Plan): string {
  const all = STUDIO_STYLE_IDS.length;
  return plan === 'pro'
    ? `${all} styles`
    : `${STUDIO_FREE_STYLES.length} of ${all} free`;
}

/** "A, B, C and D". */
const listed = (names: string[]) =>
  names.length < 2
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/** The Free banner under the cards (§10.2), after its PRO badge. */
export function proBanner(): string {
  const pro = STUDIO_STYLE_IDS.filter((id) => STUDIO_STYLES[id].plan === 'pro');
  return `${listed(pro.map((id) => STUDIO_STYLES[id].name))} come with Pro.`;
}

export const COVER_LABEL: Record<StudioCoverType, string> = {
  yours: 'Your cover',
  gradient: 'Gradient',
  plain: 'Plain',
};

/** The Cover control's choices, in the style's order (Signboard and Sprint have no gradient). */
export function coverChoices(
  style: StudioStyleId,
): { value: StudioCoverType; label: string }[] {
  return STUDIO_STYLES[style].covers.map((value) => ({
    value,
    label: COVER_LABEL[value],
  }));
}

export const MODE_LABEL: Record<StudioMode, string> = {
  light: 'Light',
  dark: 'Dark',
  auto: 'Auto',
};

/** "Clear · Blue · Auto · Your cover · 5 blocks" (§12.1, the publish summary). */
export function styleSummary(doc: StudioDocument, blockCount: number): string {
  return [
    STUDIO_STYLES[doc.style].name,
    accentHeading(doc),
    MODE_LABEL[doc.mode],
    COVER_LABEL[doc.cover],
    `${blockCount} ${blockCount === 1 ? 'block' : 'blocks'}`,
  ].join(' · ');
}
