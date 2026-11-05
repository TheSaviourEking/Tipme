import { z } from 'zod';
import type { PagePlan } from './profiles.js';

/**
 * The recipient's thank-you line on the supporter's receipt ("Make it yours"). Free: the line.
 * Pro: also a card style and a signature. A page that leaves Pro keeps every choice and shows the
 * Free version (paper, unsigned) until it returns.
 */
export const THANKS_STYLES = ['paper', 'violet', 'night'] as const;
export type ThanksStyle = (typeof THANKS_STYLES)[number];
/** Counted in code points, so it matches Postgres `char_length` (an emoji counts once). */
export const THANKS_LINE_LIMIT = 140;

/** Control characters out, whitespace collapsed to single spaces, trimmed; '' means "no line". */
export function cleanThanksLine(raw: string): string {
  return raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A scheme, `www.`, or a host: letters or digits, a dot, then at least two letters (ada.com.ng,
// tipme.xyz/@ada). A dot followed by a space ("Thanks. See you") or a digit ("No. 1") is not one.
const LINK =
  /(?:[a-z][a-z0-9+.-]*:\/\/|www\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/|\b))/i;

/** True when the text looks like a link: a scheme, `www.`, or a host with a dot and letters after it. */
export function hasLink(text: string): boolean {
  return LINK.test(text);
}

const codePoints = (text: string) => Array.from(text).length;

/**
 * A save from Settings. `line` is required (null clears it); leaving `style` or `signed` out keeps
 * what is stored, so a Free save never erases a lapsed page's Pro choices.
 */
export const thanksPatchSchema = z
  .object({
    line: z
      .string()
      // Generous before cleaning (spaces collapse); the real limit is checked after.
      .max(THANKS_LINE_LIMIT * 8)
      .nullable()
      .transform((raw) => {
        if (raw === null) return null;
        const cleaned = cleanThanksLine(raw);
        return cleaned === '' ? null : cleaned;
      })
      .refine(
        (line) => line === null || codePoints(line) <= THANKS_LINE_LIMIT,
        { message: `At most ${THANKS_LINE_LIMIT} characters.` },
      )
      .refine((line) => line === null || !hasLink(line), {
        message: 'No links.',
      }),
    style: z.enum(THANKS_STYLES).optional(),
    signed: z.boolean().optional(),
  })
  .strict();
export type ThanksPatch = z.output<typeof thanksPatchSchema>;
export type ThanksPatchRequest = z.input<typeof thanksPatchSchema>;

/** What is stored, including Pro parts a Free page keeps but does not show. */
export interface ThanksChoice {
  line: string | null;
  style: ThanksStyle;
  signed: boolean;
}

/** What a receipt shows. */
export interface ThanksSlip {
  line: string;
  style: ThanksStyle;
  /** The recipient's first name, read when the receipt is viewed; never stored. */
  signature?: string;
}

const knownStyle = (style: string | null): ThanksStyle =>
  (THANKS_STYLES as readonly string[]).includes(style ?? '')
    ? (style as ThanksStyle)
    : 'paper';

/** The stored choice as Settings shows it: NULL or an unknown style reads as paper. */
export function thanksChoiceOf(row: {
  line: string | null;
  style: string | null;
  signed: boolean;
}): ThanksChoice {
  return { line: row.line, style: knownStyle(row.style), signed: row.signed };
}

/** The first word of the display name, as the public page's "Tip Ada". */
export function firstNameOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/** What a receipt shows: null without a line; Free (or no plan) is always paper and unsigned. */
export function shownThanks(p: {
  line: string | null;
  style: string | null;
  signed: boolean;
  plan: PagePlan | undefined;
  displayName: string;
}): ThanksSlip | null {
  if (p.line === null || p.line === '') return null;
  if (p.plan !== 'pro') return { line: p.line, style: 'paper' };
  const signature = p.signed ? firstNameOf(p.displayName) : '';
  return {
    line: p.line,
    style: knownStyle(p.style),
    ...(signature ? { signature } : {}),
  };
}

/** True when a save would set a Pro-only part: a style other than paper, or signed: true. */
export function thanksNeedsPro(patch: {
  style?: ThanksStyle;
  signed?: boolean;
}): boolean {
  return (
    (patch.style !== undefined && patch.style !== 'paper') ||
    patch.signed === true
  );
}
