/** Lowercase, diacritics stripped, "&" → "and", every other non-letter or digit a single space, trimmed. */
export function normalizeBankText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Short names and nicknames people type, each pointing at words that appear in the bank's own name. */
export type BankAlias = {
  readonly aliases: readonly string[];
  readonly names: readonly string[];
};

// Targets are words from the banks' own names, never the payment partner's.
export const BANK_ALIASES: readonly BankAlias[] = [
  {
    aliases: ['gtb', 'gtco', 'gt', 'gtbank', 'guaranty'],
    names: ['guaranty trust'],
  },
  { aliases: ['fbn', 'firstbank'], names: ['first bank'] },
  { aliases: ['uba'], names: ['united bank for africa'] },
  { aliases: ['fcmb'], names: ['first city monument'] },
  { aliases: ['stanbic', 'ibtc'], names: ['stanbic ibtc'] },
  { aliases: ['opay', 'paycom'], names: ['opay', 'paycom'] },
  { aliases: ['moniepoint', 'monie'], names: ['moniepoint'] },
  { aliases: ['palmpay', 'palm'], names: ['palmpay', 'palm pay'] },
  { aliases: ['kuda'], names: ['kuda'] },
  { aliases: ['alat'], names: ['wema'] },
  { aliases: ['eco'], names: ['ecobank'] },
];

/** Whole words only, so "fbn" (first bank) never reaches "First City Monument Bank". */
function nameHas(normalizedName: string, words: string): boolean {
  return ` ${normalizedName} `.includes(` ${words} `);
}

/** True when `query` (normalized) equals one of the bank's aliases, or is a prefix of one with at least 2 characters. */
export function aliasMatches(
  query: string,
  bankName: string,
): 'exact' | 'prefix' | null {
  if (query.length < 2) return null;
  const name = normalizeBankText(bankName);
  let best: 'exact' | 'prefix' | null = null;
  for (const { aliases, names } of BANK_ALIASES) {
    if (!names.some((words) => nameHas(name, words))) continue;
    for (const alias of aliases) {
      if (alias === query) return 'exact';
      if (alias.startsWith(query)) best = 'prefix';
    }
  }
  return best;
}
