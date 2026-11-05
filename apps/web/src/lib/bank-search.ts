import { aliasMatches } from './bank-aliases.ts';
import {
  GENERIC_BANK_WORDS,
  type BankDirectory,
  type DirectoryBank,
} from './bank-directory.ts';

/** Character ranges of `bank.name` to underline, as [start, end) pairs, ascending, not overlapping. */
export type BankMatch = { bank: DirectoryBank; marks: [number, number][] };

type Mark = [number, number];

/**
 * The name as `normalizeBankText` would give it, with the index in the original name that each
 * character came from, so marks found on the normalized text land on the right letters.
 */
function normalizedWithMap(name: string): { text: string; from: number[] } {
  let text = '';
  const from: number[] = [];
  const push = (chars: string, index: number) => {
    for (const char of chars) {
      if (char === ' ' && (text === '' || text.endsWith(' '))) continue;
      text += char;
      from.push(index);
    }
  };
  for (let i = 0; i < name.length;) {
    const char = String.fromCodePoint(name.codePointAt(i)!);
    if (char === '&') push(' and ', i);
    else if (/[\p{L}\p{N}]/u.test(char))
      push(char.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase(), i);
    else push(' ', i);
    i += char.length;
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    from.pop();
  }
  // The original length, so a mark can end after the last character.
  from.push(name.length);
  return { text, from };
}

type Indexed = {
  text: string;
  from: number[];
  words: { word: string; start: number }[];
};

function indexName(name: string): Indexed {
  const { text, from } = normalizedWithMap(name);
  const words: { word: string; start: number }[] = [];
  let start = 0;
  for (const word of text.split(' ')) {
    if (word) words.push({ word, start });
    start += word.length + 1;
  }
  return { text, from, words };
}

/**
 * A range of the normalized text, as a range of the original name. The end is the next original
 * character after the one the last normalized character came from (`from` ends with the name's
 * length, so there always is one).
 */
function toOriginal(from: number[], start: number, end: number): Mark {
  const last = from[end - 1]!;
  let after = end;
  while (from[after]! <= last) after++;
  return [from[start]!, from[after]!];
}

/** Initials for scoring: the generic words are skipped, except "bank", so "gtb" spells GT Bank. */
function scoringInitials(words: Indexed['words']) {
  return words.filter(
    ({ word }) => word === 'bank' || !GENERIC_BANK_WORDS.has(word),
  );
}

type Rule = { score: number; marks: Mark[] };

function textRules(query: string, name: Indexed): Rule[] {
  const rules: Rule[] = [];
  const { text, from, words } = name;
  const range = (start: number, length: number) =>
    toOriginal(from, start, start + length);
  if (text.startsWith(query))
    rules.push({ score: 80, marks: [range(0, query.length)] });
  const word = words.find(({ word }) => word.startsWith(query));
  if (word) rules.push({ score: 70, marks: [range(word.start, query.length)] });
  if (query.length >= 2 && !query.includes(' ')) {
    const initials = scoringInitials(words);
    if (
      initials.length >= query.length &&
      initials
        .map(({ word }) => word[0])
        .join('')
        .startsWith(query)
    )
      rules.push({
        score: 60,
        marks: initials
          .slice(0, query.length)
          .map(({ start }) => range(start, 1)),
      });
  }
  const at = text.indexOf(query);
  if (at >= 0) rules.push({ score: 50, marks: [range(at, query.length)] });
  const parts = query.split(' ');
  const marks: Mark[] = [];
  let next = 0;
  for (const part of parts) {
    const index = words.findIndex(
      ({ word }, i) => i >= next && word.startsWith(part),
    );
    if (index < 0) break;
    marks.push(range(words[index]!.start, part.length));
    next = index + 1;
  }
  if (marks.length === parts.length) rules.push({ score: 40, marks });
  return rules;
}

function scoreBank(query: string, bank: DirectoryBank): Rule | null {
  const name = indexName(bank.name);
  const text = textRules(query, name);
  const alias = aliasMatches(query, bank.name);
  if (alias) {
    // An alias carries no letters of its own to underline. Use the initials when they spell
    // the query (gtb), otherwise the best text match there is (fir, opay), otherwise none.
    const initials =
      alias === 'exact' ? text.find((r) => r.score === 60) : undefined;
    return {
      score: alias === 'exact' ? 100 : 90,
      marks: (initials ?? text[0])?.marks ?? [],
    };
  }
  return text[0] ?? null;
}

const collator = new Intl.Collator('en', {
  sensitivity: 'base',
  numeric: true,
});

/** null when the query is empty after normalizing: the picker shows the grouped view instead. */
export function searchBanks(
  directory: BankDirectory,
  query: string,
): BankMatch[] | null {
  const normalized = normalizedWithMap(query).text;
  if (!normalized) return null;
  const scored: { bank: DirectoryBank; score: number; marks: Mark[] }[] = [];
  for (const bank of [...directory.all, ...directory.more]) {
    const rule = scoreBank(normalized, bank);
    if (rule) scored.push({ bank, ...rule });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      Number(b.bank.popularLabel !== null) -
        Number(a.bank.popularLabel !== null) ||
      collator.compare(a.bank.name, b.bank.name),
  );
  return scored.map(({ bank, marks }) => ({ bank, marks }));
}

/** The live count: "1 bank matches", "4 banks match", or the no-match sentence. */
export function matchCountText(count: number, query: string): string {
  if (count === 0)
    return `No bank matches "${query.trim()}". Check the spelling, or try the bank’s full name.`;
  return count === 1 ? '1 bank matches' : `${count} banks match`;
}
