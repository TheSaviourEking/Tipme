import type { TipAmounts } from '@tipme/contracts';

// The amounts a tipping page offers (PR-012): the standard Free ones, or a Pro page's own. The
// server enforces them on every quote; this only shows them and stops obvious mistakes early.
// There is no maximum tip: supporters tip what they want.

const STANDARD: TipAmounts = {
  presetsMinor: ['200000', '500000', '1000000'],
  minMinor: '200000',
};
// Not a tip limit: the largest amount the API accepts as input (12 digits of kobo).
const LARGEST_INPUT_MINOR = 999_999_999_999;

// Owner decision, 2 Nov 2026: the picker starts on NGN 2,000, or where a page does not offer it (a
// Pro page with its own amounts) on the preset closest to it, the lower on a tie. A product
// default, not an approval.
const DEFAULT_MINOR = 200_000;

function closestToDefault(presets: number[]): number | null {
  let best: number | null = null;
  for (const minor of presets) {
    const gap = Math.abs(minor - DEFAULT_MINOR);
    const bestGap = best === null ? Infinity : Math.abs(best - DEFAULT_MINOR);
    if (best === null || gap < bestGap || (gap === bestGap && minor < best))
      best = minor;
  }
  return best;
}

// The narrowest room the amount keys get in each size of card (globals.css, .amount-fit), and the
// space an exact amount needs: about 8.6px a character in the keys' bold type, plus the key's edge.
const KEY_GAP_PX = 6;
const KEY_ROOM_PX = { small: 248, medium: 288, large: 340 };
const keyWidthPx = (characters: number) => characters * 8.6 + 6;

/** Keys per row for a set of keys and at most `most` a row: fewest rows, evenest, never one alone. */
export function keysPerRow(count: number, most: number): number {
  if (count <= most) return Math.max(count, 1);
  let best = 1;
  let bestRows = Infinity;
  let bestUneven = Infinity;
  for (let perRow = Math.max(most, 1); perRow >= 1; perRow -= 1) {
    const left = count % perRow;
    if (left === 1 && perRow > 1) continue;
    const rows = Math.ceil(count / perRow);
    const uneven = left === 0 ? 0 : perRow - left;
    if (rows < bestRows || (rows === bestRows && uneven < bestUneven)) {
      best = perRow;
      bestRows = rows;
      bestUneven = uneven;
    }
  }
  return best;
}

/** Keys per row in each size of card, so full amounts such as ₦100,000 always fit whole. */
export function keyLayout(labels: string[]) {
  const longest = Math.max(0, ...labels.map((label) => label.length + 1));
  const fit = (room: number) =>
    keysPerRow(
      labels.length,
      Math.floor((room + KEY_GAP_PX) / (keyWidthPx(longest) + KEY_GAP_PX)),
    );
  return {
    small: fit(KEY_ROOM_PX.small),
    medium: fit(KEY_ROOM_PX.medium),
    large: fit(KEY_ROOM_PX.large),
  };
}

const naira = (minor: number) =>
  new Intl.NumberFormat('en').format(Math.floor(minor / 100));

export function amountOptions(amounts: TipAmounts | undefined) {
  // An API older than PR-012 sends none: the standard amounts apply there.
  const { presetsMinor, minMinor } = amounts ?? STANDARD;
  const min = Number(minMinor);
  return {
    presets: presetsMinor.map((value) => ({
      label: naira(Number(value)),
      minor: Number(value),
    })),
    minMinor: min,
    /** The preset the picker starts on: NGN 2,000 or the closest to it. Null with no presets. */
    defaultMinor: closestToDefault(presetsMinor.map(Number)),
    rangeText: `NGN ${naira(min)} or more`,
    /** An example for the typed amount: never below what this page accepts. */
    example: naira(min),
    /** A typed amount in kobo, or null when it is not a number or below this page's minimum. */
    parse(value: string): number | null {
      // Plain digits, or digits with correctly grouped thousands separators (1,500).
      const match = /^(\d{1,3}(?:,\d{3})+|\d{1,10})(?:\.(\d{1,2}))?$/.exec(
        value,
      );
      if (!match) return null;
      const whole = (match[1] ?? '').replaceAll(',', '');
      const minor =
        Number(whole) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
      return Number.isSafeInteger(minor) &&
        minor >= min &&
        minor <= LARGEST_INPUT_MINOR
        ? minor
        : null;
    },
  };
}
