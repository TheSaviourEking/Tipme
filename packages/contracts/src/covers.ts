import { z } from 'zod';
import type { PagePlan } from './profiles.js';

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

/**
 * Deepened on 2 Nov 2026 at the owner's request (the covers were too pale): each tone is at
 * least 1.45:1 against its base and each line at least 2.5:1, still under 4:1 so they stay calm.
 * Automatic covers (owner, 2 Nov 2026) use violet, forest, ocean and rose. */
export const COVER_COLOURS: readonly CoverColour[] = [
  {
    id: 'neutral',
    name: 'Neutral',
    base: '#e6e4dc',
    tone: '#bdb8a5',
    line: '#8c8672',
  },
  {
    id: 'violet',
    name: 'Violet',
    base: '#7a32f9',
    tone: '#5415c9',
    line: '#c9adff',
  },
  {
    id: 'lilac',
    name: 'Lilac',
    base: '#ece2ff',
    tone: '#c9b0fb',
    line: '#8f66e0',
  },
  {
    id: 'forest',
    name: 'Forest',
    base: '#1f4d3a',
    tone: '#357a5c',
    line: '#66a587',
  },
  {
    id: 'ocean',
    name: 'Ocean',
    base: '#1d4e89',
    tone: '#3a79c2',
    line: '#76a6dc',
  },
  {
    id: 'sun',
    name: 'Sun',
    base: '#f4c25b',
    tone: '#d99a1a',
    line: '#9a6500',
  },
  {
    id: 'rose',
    name: 'Rose',
    base: '#b83d62',
    tone: '#d9648a',
    line: '#f4a3bd',
  },
];

/** The `dark` design's fixed colours: it takes no colour of its own. */
export const COVER_DARK = {
  base: '#24221f',
  tone: '#4a463f',
  line: '#7a746a',
} as const;

/**
 * What a page gets when its owner chose nothing (owner decision, 2 Nov 2026: rich colours, so a
 * new page looks finished from day one). Three filled heart designs and four rich colours, each
 * picked by the handle. `dark` is not among them: it takes no colour, so a third of pages would
 * have skipped the decision, and its heart is pale on purpose for people who chose it.
 */
export const AUTOMATIC_DESIGNS = ['scattered', 'large', 'rising'] as const;
export const AUTOMATIC_COLOURS = ['violet', 'forest', 'ocean', 'rose'] as const;

const designById = (id: string) => COVER_DESIGNS.find((d) => d.id === id);
const colourById = (id: string) => COVER_COLOURS.find((c) => c.id === id);

/** 32-bit FNV-1a over the lower-case handle: the same in server and browser, never stored. */
function handleHash(handle: string): number {
  const lower = handle.toLowerCase();
  let hash = 0x811c9dc5;
  for (let i = 0; i < lower.length; i += 1) {
    hash ^= lower.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Murmur3's finaliser: the colour reads bits the design's remainder does not, so they spread independently. */
function mixed(hash: number): number {
  let h = hash;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The design a page gets when its owner chose nothing. Worked out, never stored, and it follows
 * the handle: a page that changes handle may change look. Changing this restyles every such
 * page, so test/covers.test.mjs pins some results. If its design has left the catalogue, the next
 * automatic one is used, so other pages keep theirs; with none left, the catalogue's first.
 */
export function automaticCover(handle: string): string {
  const start = handleHash(handle) % AUTOMATIC_DESIGNS.length;
  for (let step = 0; step < AUTOMATIC_DESIGNS.length; step += 1) {
    const id = AUTOMATIC_DESIGNS[(start + step) % AUTOMATIC_DESIGNS.length]!;
    if (designById(id)) return id;
  }
  return COVER_DESIGNS[0]?.id ?? AUTOMATIC_DESIGNS[start]!;
}

/** The colour of that automatic design, with the same fallbacks (then neutral, then the first). */
export function automaticColour(handle: string): string {
  const start = mixed(handleHash(handle)) % AUTOMATIC_COLOURS.length;
  for (let step = 0; step < AUTOMATIC_COLOURS.length; step += 1) {
    const id = AUTOMATIC_COLOURS[(start + step) % AUTOMATIC_COLOURS.length]!;
    if (colourById(id)) return id;
  }
  return colourById('neutral')?.id ?? COVER_COLOURS[0]?.id ?? 'neutral';
}

/**
 * Animated covers (owner's decision, 2 Nov 2026). Held in their own column and catalogue, so an
 * animated `ripple` never collides with the still design `ripple`. Free pages get the three
 * non-`pro` ones; the palettes are the board's.
 */
export interface CoverAnimation {
  id: string;
  name: string;
  pro: boolean;
  base: string;
  tone: string;
}

export const COVER_ANIMATIONS: readonly CoverAnimation[] = [
  {
    id: 'drift',
    name: 'Drifting',
    pro: false,
    base: '#204f3b',
    tone: '#3a7a5e',
  },
  { id: 'rise', name: 'Rising', pro: false, base: '#4d16a8', tone: '#7a32f9' },
  {
    id: 'ripple',
    name: 'Ripple',
    pro: false,
    base: '#7c2d12',
    tone: '#b45a2b',
  },
  { id: 'pulse', name: 'Pulse', pro: true, base: '#14110f', tone: '#7a32f9' },
  {
    id: 'night',
    name: 'Night sky',
    pro: true,
    base: '#101a3a',
    tone: '#3e5aa8',
  },
  { id: 'sun', name: 'Sunrise', pro: true, base: '#8a3b12', tone: '#e39a3b' },
];

export type CoverMotion = 'once' | 'loop';
export type CoverPlay = CoverMotion | 'still';

const animationById = (id: string) => COVER_ANIMATIONS.find((a) => a.id === id);

export const isProAnimation = (id: string): boolean =>
  animationById(id)?.pro === true;

/** Whether a choice is part of Pro: a Pro animation, a slow loop, or a colour on an animation. */
export function coverChoiceNeedsPro(c: CoverDesignChoice): boolean {
  if (!c.animation) return false;
  return isProAnimation(c.animation) || c.motion === 'loop' || !!c.colour;
}

/**
 * How an animation plays. A Pro page plays its saved motion (once when none). Any other page
 * shows the still frame for anything Pro-only (a Pro animation or a saved colour) and plays
 * the rest once, whatever motion is saved. Nothing is deleted, so returning to Pro restores it.
 */
export function coverPlay(p: {
  animation: string;
  colour: string | null;
  motion: CoverMotion | null;
  plan: PagePlan | undefined;
}): CoverPlay {
  if (p.plan === 'pro') return p.motion ?? 'once';
  return isProAnimation(p.animation) || p.colour ? 'still' : 'once';
}

export type ResolvedCover =
  | { kind: 'photo'; path: string }
  | { kind: 'design'; design: string; colour?: string }
  | { kind: 'animated'; animation: string; colour?: string; play: CoverPlay };

/** What a page shows: uploaded photo, then animation, then chosen design, then automatic. */
export function resolveCover(p: {
  handle: string;
  coverPath: string | null;
  coverDesign: string | null;
  coverColour: string | null;
  coverAnimation?: string | null;
  coverMotion?: string | null;
  plan?: string;
}): ResolvedCover {
  if (p.coverPath) return { kind: 'photo', path: p.coverPath };
  const animation = p.coverAnimation
    ? animationById(p.coverAnimation)
    : undefined;
  if (animation) {
    const colour = p.coverColour ? colourById(p.coverColour) : undefined;
    const motion =
      p.coverMotion === 'once' || p.coverMotion === 'loop'
        ? p.coverMotion
        : null;
    return {
      kind: 'animated',
      animation: animation.id,
      ...(colour ? { colour: colour.id } : {}),
      play: coverPlay({
        animation: animation.id,
        colour: colour?.id ?? null,
        motion,
        plan: p.plan === 'pro' ? 'pro' : p.plan === 'free' ? 'free' : undefined,
      }),
    };
  }
  const chosen = p.coverDesign ? designById(p.coverDesign) : undefined;
  const id = chosen?.id ?? automaticCover(p.handle);
  if (!(chosen ?? designById(id))?.colours)
    return { kind: 'design', design: id };
  // A chosen design keeps its saved colour, or neutral; nothing chosen gets the handle's colour.
  const picked = chosen
    ? p.coverColour
      ? colourById(p.coverColour)
      : undefined
    : colourById(automaticColour(p.handle));
  // Neutral by default; the first colour if neutral itself has been removed.
  const colour = picked ?? colourById('neutral') ?? COVER_COLOURS[0];
  return {
    kind: 'design',
    design: id,
    ...(colour ? { colour: colour.id } : {}),
  };
}

/**
 * `PUT /v1/me/cover-design`. `design: null` with no animation clears the choice, back to
 * automatic. An animation replaces the still design, so the two are never sent together.
 */
export const coverDesignChoiceSchema = z
  .object({
    design: z.string().max(40).nullable(),
    colour: z.string().max(40).nullable().optional(),
    animation: z.string().max(40).nullable().optional(),
    motion: z.enum(['once', 'loop']).optional(),
  })
  .strict()
  .superRefine(({ design, colour, animation, motion }, context) => {
    if (animation) {
      if (design !== null)
        context.addIssue({
          code: 'custom',
          path: ['design'],
          message: 'an animation replaces the design',
        });
      if (!animationById(animation))
        context.addIssue({
          code: 'custom',
          path: ['animation'],
          message: 'unknown animation',
        });
      if (colour && !colourById(colour))
        context.addIssue({
          code: 'custom',
          path: ['colour'],
          message: 'colour not available',
        });
      return;
    }
    if (motion !== undefined)
      context.addIssue({
        code: 'custom',
        path: ['motion'],
        message: 'motion needs an animation',
      });
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
