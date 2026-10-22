import type { TipAmounts } from '@tipme/contracts';

// The amounts a tipping page offers (PR-012): the standard Free ones, or a Pro page's own. The
// server enforces them on every quote; this only shows them and stops obvious mistakes early.

const STANDARD: TipAmounts = {
  presetsMinor: ['100000', '200000', '500000'],
  minMinor: '100000',
  maxMinor: '10000000',
};

const naira = (minor: number) =>
  new Intl.NumberFormat('en').format(Math.floor(minor / 100));

export function amountOptions(amounts: TipAmounts | undefined) {
  // An API older than PR-012 sends none: the standard amounts apply there.
  const { presetsMinor, minMinor, maxMinor } = amounts ?? STANDARD;
  const min = Number(minMinor);
  const max = Number(maxMinor);
  return {
    presets: presetsMinor.map((value) => ({
      label: naira(Number(value)),
      minor: Number(value),
    })),
    minMinor: min,
    rangeText: `${naira(min)} to ${naira(max)} NGN`,
    /** A typed amount in kobo, or null when it is not a number or outside this page's range. */
    parse(value: string): number | null {
      // Plain digits, or digits with correctly grouped thousands separators (1,500).
      const match = /^(\d{1,3}(?:,\d{3})+|\d{1,6})(?:\.(\d{1,2}))?$/.exec(
        value,
      );
      if (!match) return null;
      const whole = (match[1] ?? '').replaceAll(',', '');
      const minor =
        Number(whole) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
      return Number.isSafeInteger(minor) && minor >= min && minor <= max
        ? minor
        : null;
    },
  };
}
