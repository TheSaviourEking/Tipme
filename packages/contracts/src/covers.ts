import { z } from 'zod';

// The cover catalogue (design spec §6), shared by web and API. It is a list on purpose: removing
// an option means deleting one entry. A page still holding a removed option falls back in
// `resolveCover`, so no migration is needed.

export interface CoverDesign {
  id: string;
  name: string;
  /** Whether the design takes one of `COVER_COLOURS`. */
  colours: boolean;
}

export interface CoverColour {
  id: string;
  name: string;
  base: string;
  tone: string;
  /** For designs drawn in outline: readable on `base`, but quiet. */
  line: string;
}

export const COVER_DESIGNS: readonly CoverDesign[] = [
  { id: 'scattered', name: 'Scattered hearts', colours: true },
  { id: 'large', name: 'One large heart', colours: true },
  { id: 'dark', name: 'Dark', colours: false },
  { id: 'outline', name: 'Outlined hearts', colours: true },
  { id: 'ripple', name: 'Rippling heart', colours: true },
  { id: 'rising', name: 'Rising hearts', colours: true },
  { id: 'indigo', name: 'Indigo Grid', colours: false },
  { id: 'woven', name: 'Woven Strips', colours: false },
  { id: 'danfo', name: 'Danfo', colours: false },
  { id: 'harmattan', name: 'Harmattan', colours: false },
  { id: 'lagoon', name: 'Lagoon', colours: false },
  { id: 'citylights', name: 'City Lights', colours: false },
  { id: 'vinyl', name: 'Vinyl', colours: false },
  { id: 'waveform', name: 'Waveform', colours: false },
  { id: 'sunburst', name: 'Sunburst', colours: false },
  { id: 'engraved', name: 'Engraved', colours: false },
  { id: 'contour', name: 'Contour', colours: false },
  { id: 'flow', name: 'Flow', colours: false },
  { id: 'geometry', name: 'Geometry', colours: false },
  { id: 'overprint', name: 'Overprint Heart', colours: false },
  { id: 'paper', name: 'Paper Hearts', colours: false },
  { id: 'terrazzo', name: 'Terrazzo', colours: false },
  { id: 'opcheck', name: 'Op Check', colours: false },
  { id: 'confetti', name: 'Confetti Hearts', colours: false },
];

/** Violet and lilac are chosen by the person, never automatic (spec §6). */
export const COVER_COLOURS: readonly CoverColour[] = [
  {
    id: 'neutral',
    name: 'Neutral',
    base: '#e6e4dc',
    tone: '#d6d3c8',
    line: '#bdb9ab',
  },
  {
    id: 'violet',
    name: 'Violet',
    base: '#7a32f9',
    tone: '#6723e8',
    line: '#b08dff',
  },
  {
    id: 'lilac',
    name: 'Lilac',
    base: '#ece2ff',
    tone: '#ddcbff',
    line: '#bfa5f5',
  },
  {
    id: 'forest',
    name: 'Forest',
    base: '#1f4d3a',
    tone: '#2a6049',
    line: '#4f8a70',
  },
  {
    id: 'ocean',
    name: 'Ocean',
    base: '#1d4e89',
    tone: '#2a609f',
    line: '#5b8fcc',
  },
  { id: 'sun', name: 'Sun', base: '#f4c25b', tone: '#ebb03b', line: '#c98f1a' },
  {
    id: 'rose',
    name: 'Rose',
    base: '#b83d62',
    tone: '#c9547a',
    line: '#e07a9b',
  },
];

/** The `dark` design's fixed colours: it takes no colour of its own. */
export const COVER_DARK = { base: '#24221f', tone: '#33302b' } as const;

const AUTOMATIC = ['scattered', 'large', 'dark'] as const;

const designById = (id: string) => COVER_DESIGNS.find((d) => d.id === id);
const colourById = (id: string) => COVER_COLOURS.find((c) => c.id === id);

/**
 * The design a page gets when its owner chose nothing: 32-bit FNV-1a over the lower-case handle.
 * Runs alike in server and browser and is worked out, never stored. Changing this restyles every
 * such page, so test/covers.test.mjs pins some results. If its design has left the catalogue, the
 * next automatic one is used, so other pages keep theirs; with none left, the catalogue's first.
 */
export function automaticCover(handle: string): string {
  const lower = handle.toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < lower.length; i += 1) {
    hash ^= lower.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const start = (hash >>> 0) % AUTOMATIC.length;
  for (let step = 0; step < AUTOMATIC.length; step += 1) {
    const id = AUTOMATIC[(start + step) % AUTOMATIC.length]!;
    if (designById(id)) return id;
  }
  return COVER_DESIGNS[0]?.id ?? AUTOMATIC[start]!;
}

export type ResolvedCover =
  | { kind: 'photo'; path: string }
  | { kind: 'design'; design: string; colour?: string };

/** What a page shows: uploaded photo, then chosen design, then automatic. */
export function resolveCover(p: {
  handle: string;
  coverPath: string | null;
  coverDesign: string | null;
  coverColour: string | null;
}): ResolvedCover {
  if (p.coverPath) return { kind: 'photo', path: p.coverPath };
  const chosen = p.coverDesign ? designById(p.coverDesign) : undefined;
  const id = chosen?.id ?? automaticCover(p.handle);
  if (!(chosen ?? designById(id))?.colours)
    return { kind: 'design', design: id };
  const picked =
    chosen && p.coverColour ? colourById(p.coverColour) : undefined;
  // Neutral by default; the first colour if neutral itself has been removed.
  const colour = picked ?? colourById('neutral') ?? COVER_COLOURS[0];
  return {
    kind: 'design',
    design: id,
    ...(colour ? { colour: colour.id } : {}),
  };
}

/** `PUT /v1/me/cover-design`. `design: null` clears the choice, back to automatic. */
export const coverDesignChoiceSchema = z
  .object({
    design: z.string().max(40).nullable(),
    colour: z.string().max(40).nullable().optional(),
  })
  .strict()
  .superRefine(({ design, colour }, context) => {
    const known = design === null ? null : designById(design);
    if (known === undefined)
      context.addIssue({
        code: 'custom',
        path: ['design'],
        message: 'unknown design',
      });
    if (colour === null || colour === undefined) return;
    if (!known?.colours || !colourById(colour))
      context.addIssue({
        code: 'custom',
        path: ['colour'],
        message: 'colour not available',
      });
  });
export type CoverDesignChoice = z.infer<typeof coverDesignChoiceSchema>;
