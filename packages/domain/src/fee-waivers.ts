import { FEE_WAIVED_VERSION_INFIX, lagosDayStart } from './fees.js';

/**
 * Fee waivers (spec 2026-11-23 §4): which rule decides who pays a fee, and the dates it covers.
 * Pure logic, no I/O. The database package stores the rows; callers pass the rows of one key.
 */

export const FEE_WAIVER_KINDS = ['individual', 'business', 'giving'] as const;
export const FEE_WAIVER_FEES = ['tip', 'withdrawal'] as const;
export const FEE_WAIVER_PAYERS = ['tipme', 'account', 'inherit'] as const;
export type FeeWaiverKind = (typeof FEE_WAIVER_KINDS)[number];
export type FeeWaiverFee = (typeof FEE_WAIVER_FEES)[number];
export type FeeWaiverPayer = (typeof FEE_WAIVER_PAYERS)[number];

export interface FeeWaiverRule {
  id: string;
  scope: 'kind' | 'account';
  kind: FeeWaiverKind;
  accountId: string | null;
  fee: FeeWaiverFee;
  payer: FeeWaiverPayer;
  startsAt: Date;
  endsAt: Date | null;
  createdAt: Date;
}

/** Both a rule's start and its end may be at most this many calendar months after it is acted on (W4). */
export const FEE_WAIVER_MAX_AHEAD_MONTHS = 24;

/** The version recorded on a quote whose fee TipMe covered under rule `ruleId`. */
export const waivedFeeVersion = (base: string, ruleId: string): string =>
  `${base}${FEE_WAIVED_VERSION_INFIX}${ruleId}`;

/**
 * The rule in force for one key (scope, kind, account, fee) at `now` (W2). It is the row with the
 * greatest `startsAt <= now` (ties: latest `createdAt`). If that row has ended, the key has no
 * rule: an older row is never revived. Upcoming rows are ignored.
 */
export function currentRuleOfKey(
  rows: readonly FeeWaiverRule[],
  now: Date,
): FeeWaiverRule | null {
  let latest: FeeWaiverRule | null = null;
  for (const r of rows) {
    if (r.startsAt.getTime() > now.getTime()) continue;
    if (
      latest === null ||
      r.startsAt.getTime() > latest.startsAt.getTime() ||
      (r.startsAt.getTime() === latest.startsAt.getTime() &&
        r.createdAt.getTime() > latest.createdAt.getTime())
    ) {
      latest = r;
    }
  }
  if (
    latest !== null &&
    latest.endsAt !== null &&
    latest.endsAt.getTime() <= now.getTime()
  ) {
    return null;
  }
  return latest;
}

export interface FeeWaiverResolution {
  payer: 'tipme' | 'default';
  ruleId: string | null;
  endsAt: Date | null;
}

/**
 * Who pays (§4). An account rule other than `inherit` wins: `tipme` gives `tipme`; `account` gives
 * `default` (the account opts out of a kind-wide waiver). Otherwise the kind rule applies, and
 * otherwise today's default.
 */
export function resolveFeeWaiver(input: {
  accountRows: readonly FeeWaiverRule[];
  kindRows: readonly FeeWaiverRule[];
  now: Date;
}): FeeWaiverResolution {
  const none: FeeWaiverResolution = {
    payer: 'default',
    ruleId: null,
    endsAt: null,
  };
  const account = currentRuleOfKey(input.accountRows, input.now);
  if (account !== null && account.payer !== 'inherit') {
    return account.payer === 'tipme'
      ? { payer: 'tipme', ruleId: account.id, endsAt: account.endsAt }
      : none;
  }
  const kind = currentRuleOfKey(input.kindRows, input.now);
  if (kind !== null && kind.payer === 'tipme') {
    return { payer: 'tipme', ruleId: kind.id, endsAt: kind.endsAt };
  }
  return none;
}

/** Why a rule's shape is not allowed (W1, W5), or null. A reason is for the staff member, not a code. */
export function feeWaiverShapeProblem(r: {
  scope: 'kind' | 'account';
  kind: FeeWaiverKind;
  fee: FeeWaiverFee;
  payer: FeeWaiverPayer;
  hasAccount: boolean;
}): string | null {
  if (r.scope === 'account' && !r.hasAccount)
    return 'An account rule needs an account.';
  if (r.scope === 'kind' && r.hasAccount)
    return 'A kind-wide rule has no account.';
  if (r.scope === 'kind' && r.payer === 'inherit') {
    return 'Only an account rule can inherit.';
  }
  if (r.scope === 'account' && r.kind === 'giving') {
    return 'Giving has no accounts yet, so it can only have a kind-wide rule.';
  }
  if (r.fee === 'tip' && r.kind === 'business')
    return 'Businesses have no tip fee.';
  return null;
}

// UTC month maths is intentional (W4); it can only be stricter than Lagos-calendar maths.
/** `date` plus `months` calendar months in UTC, the day clamped to the target month's length. */
function addUtcMonths(date: Date, months: number): Date {
  const total = date.getUTCMonth() + months;
  const year = date.getUTCFullYear() + Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const out = new Date(date.getTime());
  out.setUTCFullYear(year, month, Math.min(date.getUTCDate(), lastDay));
  return out;
}

/**
 * The dates a rule acted on at `now` will have (W3, W4). It is never retroactive: a start in the
 * past becomes `now`. Returns the field at fault when a bound is broken.
 */
export function feeWaiverWindow(input: {
  requestedStart: Date | null;
  endsAt: Date | null;
  now: Date;
}): { startsAt: Date; endsAt: Date | null } | 'endsAt' | 'startsAt' {
  const { now, endsAt } = input;
  const startsAt =
    input.requestedStart !== null &&
    input.requestedStart.getTime() > now.getTime()
      ? input.requestedStart
      : now;
  const max = addUtcMonths(now, FEE_WAIVER_MAX_AHEAD_MONTHS).getTime();
  if (startsAt.getTime() > max) return 'startsAt';
  if (
    endsAt !== null &&
    (endsAt.getTime() <= startsAt.getTime() || endsAt.getTime() > max)
  ) {
    return 'endsAt';
  }
  return { startsAt, endsAt };
}

// --- Lagos dates (UTC+1, no daylight saving; the day helper lives in fees.ts) ---

const LAGOS_OFFSET_MS = 3_600_000;
const DAY_MS = 86_400_000;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The Lagos calendar date (YYYY-MM-DD) of an instant. */
const lagosDate = (at: Date): string =>
  new Date(lagosDayStart(at).getTime() + LAGOS_OFFSET_MS)
    .toISOString()
    .slice(0, 10);

/** The last Lagos date a waiver ending at `endsAt` covers: the date of `endsAt - 1 ms`. */
export const lastCoveredLagosDate = (endsAt: Date): string =>
  lagosDate(new Date(endsAt.getTime() - 1));

/** The instant the Lagos day after `date` (YYYY-MM-DD) starts, as an ISO string: `until 31 Jan` ends here. */
export function endOfLagosDayIso(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new RangeError(`Not a YYYY-MM-DD date: ${date}`);
  const midnightUtc = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(midnightUtc)) throw new RangeError(`Not a date: ${date}`);
  return new Date(midnightUtc + DAY_MS - LAGOS_OFFSET_MS).toISOString();
}

/** "31 Jan 2027": a Lagos calendar date (YYYY-MM-DD) in words. */
function dateWords(date: string, withYear: boolean): string {
  const [y, m, day] = date.split('-').map(Number) as [number, number, number];
  const words = `${day} ${MONTHS[m - 1]}`;
  return withYear ? `${words} ${y}` : words;
}

/** "until 31 Jan", with the year ("until 31 Jan 2027") when it is not the current Lagos year. */
export function untilWords(endsAt: Date, now: Date): string {
  const last = lastCoveredLagosDate(endsAt);
  return `until ${dateWords(last, last.slice(0, 4) !== lagosDate(now).slice(0, 4))}`;
}

/**
 * "until 31 Jan 2027", always with the year: for words stored and compared later (an approval's
 * summary), which must not change with the clock.
 */
export const untilWordsWithYear = (endsAt: Date): string =>
  `until ${dateWords(lastCoveredLagosDate(endsAt), true)}`;

/** "from 5 Dec 2026": the Lagos date a rule starts on, always with the year (as untilWordsWithYear). */
export const fromWordsWithYear = (startsAt: Date): string =>
  `from ${dateWords(lagosDate(startsAt), true)}`;
