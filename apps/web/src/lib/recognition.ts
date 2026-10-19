/**
 * Device-only memory of a supporter's own confirmed tips, used to celebrate them after a tip is
 * paid (never before choosing an amount, never as a comparison). Holds no amounts and no messages,
 * is written only when the supporter opted in, and never leaves this browser.
 */
export const MY_TIPS_KEY = 'tipme.myTips.v1';
const MAX_TIPS = 500;
// Far above 500 small entries; anything larger is not ours.
const MAX_BYTES = 200_000;

export interface RememberedTip {
  id: string;
  handle: string;
  at: string;
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const isTip = (value: unknown): value is RememberedTip => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, handle, at } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    typeof handle === 'string' &&
    typeof at === 'string' &&
    id.length <= 64 &&
    handle.length <= 60 &&
    at.length <= 40
  );
};

interface MyTipsRecord {
  tips: RememberedTip[];
  /** Running totals: they keep counting after the oldest tips leave the capped list. */
  count: number;
  peopleCount: number;
  /** Distinct handles (lower case) seen so far, capped; used only to count people. */
  people: string[];
}
const MAX_PEOPLE = 1000;
const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function readRecord(storage: StorageLike | undefined): MyTipsRecord {
  const empty: MyTipsRecord = {
    tips: [],
    count: 0,
    peopleCount: 0,
    people: [],
  };
  try {
    const raw = storage?.getItem(MY_TIPS_KEY);
    if (!raw || raw.length > MAX_BYTES) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return empty;
    const { v, tips, count, peopleCount, people } = parsed as Record<
      string,
      unknown
    >;
    if (v !== 1 || !Array.isArray(tips) || !tips.every(isTip)) return empty;
    const derivedPeople = [
      ...new Set(tips.map((tip) => tip.handle.toLowerCase())),
    ];
    const knownPeople =
      Array.isArray(people) &&
      people.length <= MAX_PEOPLE &&
      people.every(
        (handle) => typeof handle === 'string' && handle.length <= 60,
      )
        ? (people as string[])
        : derivedPeople;
    // Records from before the totals existed (or tampered totals) fall back to the list itself.
    return {
      tips,
      count: isCount(count) && count >= tips.length ? count : tips.length,
      peopleCount:
        isCount(peopleCount) && peopleCount >= knownPeople.length
          ? peopleCount
          : knownPeople.length,
      people: knownPeople,
    };
  } catch {
    return empty;
  }
}

/** Corrupt, foreign, oversized or unreadable records read as empty. */
export function readMyTips(storage: StorageLike | undefined): {
  tips: RememberedTip[];
} {
  return { tips: readRecord(storage).tips };
}

/** Adds a paid tip once (by id) and returns the totals to celebrate. Storage failures are ignored. */
export function rememberTip(
  storage: StorageLike | undefined,
  tip: RememberedTip,
): { count: number; people: number } {
  const record = readRecord(storage);
  if (record.tips.some((known) => known.id === tip.id))
    return { count: record.count, people: record.peopleCount };
  const handle = tip.handle.toLowerCase();
  const newPerson = !record.people.includes(handle);
  const next: MyTipsRecord = {
    tips: [
      ...record.tips,
      { id: tip.id, handle: tip.handle, at: tip.at },
    ].slice(-MAX_TIPS),
    count: record.count + 1,
    // Past the cap a returning person may be counted again: a rare, harmless overcount.
    peopleCount: record.peopleCount + (newPerson ? 1 : 0),
    people:
      newPerson && record.people.length < MAX_PEOPLE
        ? [...record.people, handle]
        : record.people,
  };
  try {
    storage?.setItem(MY_TIPS_KEY, JSON.stringify({ v: 1, ...next }));
  } catch {
    // Private mode or a full quota: celebrate this time, remember nothing.
  }
  return { count: next.count, people: next.peopleCount };
}

export function forgetMyTips(storage: StorageLike | undefined): void {
  try {
    storage?.removeItem(MY_TIPS_KEY);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}

const ordinal = (n: number): string => {
  if (n === 1) return 'first';
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen
    ? 'th'
    : (({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ??
      'th');
  return `${n}${suffix}`;
};

/** Celebrates; never compares. */
export function recognitionMessage({
  count,
  people,
}: {
  count: number;
  people: number;
}): string {
  const reach =
    count === 1
      ? "someone's day"
      : people === 1
        ? "1 person's day"
        : `${people} people's day`;
  return `That's your ${ordinal(count)} tip. You've made ${reach}. We see you.`;
}
