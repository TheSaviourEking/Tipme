import type { StudioStyleId } from '@tipme/contracts';
// The extension lets `node --test` import this file directly (test/tip-skin-label.test.mjs).
import { formatNaira } from '../lib/demo-amount.ts';

type TipSkin = Exclude<StudioStyleId, 'classic'>;

/** Creator's two decided lines (addendum 2026-11-27-studio-creator-professional §6.5). */
const CREATOR_LINES = ['Support my work', 'Give, tip or appreciate'] as const;

/**
 * Professional's pill (§6.5): the words before and after the amount, "Send a ₦2,000 tip". With no
 * valid amount the two halves meet: "Send a tip". The form draws the amount between them.
 */
export const PROFESSIONAL_WORDS = ['Send a', 'tip'] as const;

/**
 * The in-page Tip's fixed words for a skin; null keeps "Tip ₦…". Part of the style's look, keyed
 * by the skin, never stored or edited (§6.5). `name` is the button's accessible name: exactly the
 * words it shows, both lines (Creator) or the one line (Professional) and the chosen amount
 * (ruling S-R5, WCAG 2.5.3 label in name, which supersedes §6.5's "Support my work, tip ₦2,000").
 * The sticky bar keeps "Tip ₦…" in every style.
 */
export function skinTipLabel(
  skin: TipSkin,
  amountMinor: string | number | bigint | null,
): { name: string; lines?: readonly [string, string] } | null {
  const amount = amountMinor === null ? [] : [formatNaira(amountMinor)];
  if (skin === 'professional')
    return {
      name: [PROFESSIONAL_WORDS[0], ...amount, PROFESSIONAL_WORDS[1]].join(' '),
    };
  if (skin !== 'creator') return null;
  return {
    name: [...CREATOR_LINES, ...amount].join(' '),
    lines: CREATOR_LINES,
  };
}
