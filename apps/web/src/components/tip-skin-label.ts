import type { StudioStyleId } from '@tipme/contracts';
import { formatNaira } from '../lib/demo-amount.ts';

type TipSkin = Exclude<StudioStyleId, 'classic'>;

/** Creator's two decided lines (addendum 2026-11-27-studio-creator-professional §6.5). */
const CREATOR_LINES = ['Support my work', 'Give, tip or appreciate'] as const;

/**
 * The in-page Tip's fixed words for a skin; null keeps "Tip ₦…". Part of the style's look, keyed
 * by the skin, never stored or edited (§6.5). `name` is the button's accessible name: exactly the
 * words it shows, both lines and the chosen amount (ruling S-R5, WCAG 2.5.3 label in name, which
 * supersedes §6.5's "Support my work, tip ₦2,000"). The sticky bar keeps "Tip ₦…" in every style.
 */
export function skinTipLabel(
  skin: TipSkin,
  amountMinor: string | number | bigint | null,
): { name: string; lines?: readonly [string, string] } | null {
  if (skin !== 'creator') return null;
  return {
    name: [
      ...CREATOR_LINES,
      ...(amountMinor === null ? [] : [formatNaira(amountMinor)]),
    ].join(' '),
    lines: CREATOR_LINES,
  };
}
