import type { PayoutBank } from '@tipme/contracts';
// The .ts extension lets `node --test` load this module directly, as the web tests do.
import { normalizeBankText } from './bank-aliases.ts';

export type BankBadge = {
  initials: string;
  tone: string | null;
  ink: '#000000' | '#FFFFFF' | null;
};
export type DirectoryBank = PayoutBank & {
  badge: BankBadge;
  popularLabel: string | null;
};
export type BankDirectory = {
  /** Board order, only those whose code is in the list. */
  popular: DirectoryBank[];
  /** A to Z: commercial banks, wallets, and every popular bank. */
  all: DirectoryBank[];
  /** A to Z: microfinance and mortgage banks that are not popular. */
  more: DirectoryBank[];
};
export type PopularBank = {
  label: string;
  initials: string;
  tone: string;
  codes: readonly string[];
};

// The board's keys, tones and order. A bank is popular by code only (owner, 5 Nov 2026): the
// fintech codes are the institution codes in common use and could not be checked against the
// partner's live list, so a key whose code the partner doesn't use simply doesn't show.
export const POPULAR_BANKS: readonly PopularBank[] = [
  { label: 'GTBank', initials: 'GT', tone: '#dd4f05', codes: ['058'] },
  { label: 'Access', initials: 'AC', tone: '#e0761c', codes: ['044'] },
  { label: 'Zenith', initials: 'ZB', tone: '#d1122a', codes: ['057'] },
  { label: 'UBA', initials: 'UB', tone: '#c8102e', codes: ['033'] },
  { label: 'First Bank', initials: 'FB', tone: '#003b65', codes: ['011'] },
  {
    label: 'OPay',
    initials: 'OP',
    tone: '#1dcf9f',
    codes: ['999992', '100004'],
  },
  {
    label: 'Moniepoint',
    initials: 'MP',
    tone: '#0357ee',
    codes: ['50515', '090405'],
  },
  {
    label: 'PalmPay',
    initials: 'PP',
    tone: '#6b2ff5',
    codes: ['999991', '100033'],
  },
  {
    label: 'Kuda',
    initials: 'KU',
    tone: '#40196d',
    codes: ['50211', '090267'],
  },
];

const hasWord = (normalized: string, words: string) =>
  ` ${normalized} `.includes(` ${words} `);

export function bankKind(name: string): 'bank' | 'microfinance' | 'mortgage' {
  const normalized = normalizeBankText(name);
  if (
    ['microfinance', 'micro finance', 'mfb'].some((w) => hasWord(normalized, w))
  )
    return 'microfinance';
  if (hasWord(normalized, 'mortgage')) return 'mortgage';
  return 'bank';
}

/** Words that say what kind of institution it is, not which one. */
export const GENERIC_BANK_WORDS: ReadonlySet<string> = new Set([
  'bank',
  'nigeria',
  'plc',
  'limited',
  'ltd',
  'of',
  'the',
  'and',
  'microfinance',
  'mfb',
  'mortgage',
]);

export function initialsFor(name: string): string {
  const words = normalizeBankText(name).split(' ').filter(Boolean);
  const kept = words.filter((word) => !GENERIC_BANK_WORDS.has(word));
  const initials =
    kept.length >= 2
      ? `${kept[0]![0]}${kept[1]![0]}`
      : kept.length === 1
        ? kept[0]!.slice(0, 2)
        : normalizeBankText(name).replace(/ /g, '').slice(0, 2);
  return initials.toUpperCase();
}

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(
    (channel) => {
      const c = channel / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    },
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG relative-luminance contrast of two #RRGGBB colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

const collator = new Intl.Collator('en', {
  sensitivity: 'base',
  numeric: true,
});
const byName = (a: DirectoryBank, b: DirectoryBank) =>
  collator.compare(a.name, b.name) ||
  (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);

export function arrangeBanks(banks: readonly PayoutBank[]): BankDirectory {
  const seen = new Set<string>();
  const popularByIndex = new Map<number, DirectoryBank>();
  const all: DirectoryBank[] = [];
  const more: DirectoryBank[] = [];
  for (const { code, name } of banks) {
    if (seen.has(code)) continue;
    seen.add(code);
    const index = POPULAR_BANKS.findIndex((bank) => bank.codes.includes(code));
    const popular = POPULAR_BANKS[index];
    if (popular) {
      const ink =
        contrastRatio(popular.tone, '#000000') >=
        contrastRatio(popular.tone, '#FFFFFF')
          ? '#000000'
          : '#FFFFFF';
      const bank: DirectoryBank = {
        code,
        name,
        badge: { initials: popular.initials, tone: popular.tone, ink },
        popularLabel: popular.label,
      };
      all.push(bank);
      // One key per popular bank, even if the partner lists it under two of its codes.
      if (!popularByIndex.has(index)) popularByIndex.set(index, bank);
      continue;
    }
    const bank: DirectoryBank = {
      code,
      name,
      badge: { initials: initialsFor(name), tone: null, ink: null },
      popularLabel: null,
    };
    (bankKind(name) === 'bank' ? all : more).push(bank);
  }
  return {
    popular: [...popularByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, bank]) => bank),
    all: all.sort(byName),
    more: more.sort(byName),
  };
}

/**
 * The element id of a bank's option. A partner code may hold spaces or other characters an id
 * can't carry as one IDREF (aria-activedescendant), so it is percent-encoded with "_" for "%";
 * "_" itself is encoded first, so two codes never share an id.
 */
export function bankOptionId(prefix: string, code: string): string {
  const safe = encodeURIComponent(code).replace(/_/g, '%5F').replace(/%/g, '_');
  return `${prefix}-${safe}`;
}
