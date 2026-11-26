import {
  endOfLagosDayIso,
  lagosDateOf,
  lagosDayStart,
  untilWords,
} from '@tipme/domain';

/*
 * The dates staff pick for a fee waiver (spec 2026-11-23 §6, R5). A waiver's end is stored as the
 * instant its last Lagos day ends, so every screen shows the day picked and never the day after.
 * Only the domain's helpers calculate: this file names them for the screens.
 */

/** The last day TipMe pays (YYYY-MM-DD, Lagos) as the instant the next Lagos day starts, UTC `Z`. */
export const endOfLagosDay = (date: string): string => endOfLagosDayIso(date);

/** The first day (YYYY-MM-DD, Lagos) as the instant it starts, UTC `Z`: the day before's end. */
export const startOfLagosDay = (date: string): string =>
  lagosDayStart(new Date(Date.parse(endOfLagosDayIso(date)) - 1)).toISOString();

/** "until 31 Jan" (the last Lagos day covered), with the year when it isn't this Lagos year. */
export const untilLabel = (iso: string, now: Date = new Date()): string =>
  untilWords(new Date(iso), now);

/** Today's Lagos date (YYYY-MM-DD): the earliest day a date field offers. */
export const lagosToday = (now: Date = new Date()): string => lagosDateOf(now);
