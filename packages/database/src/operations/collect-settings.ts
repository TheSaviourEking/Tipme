import { desc, lte } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { collectSettings } from '../schema.js';

/*
 * You collect's settings (spec §9; ADR-0016, PROPOSED), read like the plan fee rates
 * (plan-fee-rates.ts): append-only history, the latest row whose `effective_from` has passed is in
 * force, and the coded defaults when none is stored. Read when used, never cached, so a change applies
 * at once. Changing them (the serious action, audit and owner alert) is Task 12.
 */

export interface CollectSettings {
  /** The most TipMe holds for one recipient who hasn't added bank details (kobo). */
  capMinor: bigint;
  /** How long it holds it, in days. */
  capDays: number;
  /** The days after the first tip on which the recipient is reminded, each below `capDays`. */
  reminderDays: number[];
  /** The new-recipient delay: a share is sent this many hours after the tip settles... */
  delayHours: number;
  /** ...for this many days after the recipient signs up. */
  delayForDays: number;
  /** The most a new account can withdraw the first time (kobo). */
  firstWithdrawalCapMinor: bigint;
  /** The most a new account can withdraw in a Lagos day (kobo)... */
  newDailyLimitMinor: bigint;
  /** ...for this many days after it is verified. */
  newDailyLimitDays: number;
  /** TipMe's own money above what it holds for recipients: alert levels (kobo). */
  reserveWarningMinor: bigint;
  reserveCriticalMinor: bigint;
  /** Staff paused every collect transfer (ruling R11). */
  paused: boolean;
}

/** The spec's defaults (§9), in force while no setting is stored. */
export const COLLECT_DEFAULTS: Readonly<CollectSettings> = Object.freeze({
  capMinor: 5_000_000n,
  capDays: 30,
  reminderDays: Object.freeze([7, 21, 28]) as number[],
  delayHours: 24,
  delayForDays: 7,
  firstWithdrawalCapMinor: 5_000_000n,
  newDailyLimitMinor: 20_000_000n,
  newDailyLimitDays: 30,
  reserveWarningMinor: 50_000_000n,
  reserveCriticalMinor: 25_000_000n,
  paused: false,
});

export interface CollectSettingsInForce extends CollectSettings {
  /** `setting` when a stored row is in force, `default` for the coded defaults. */
  source: 'setting' | 'default';
  /** The stored row in force, if any. */
  rowId: string | null;
}

/**
 * The settings in force now: the latest stored row whose `effective_from` has passed, or
 * `COLLECT_DEFAULTS`. The table's checks keep a stored row in the spec's bounds.
 */
export async function collectSettingsInForce(
  db: Database | Tx,
  now: Date = new Date(),
): Promise<CollectSettingsInForce> {
  const [row] = await db
    .select()
    .from(collectSettings)
    .where(lte(collectSettings.effectiveFrom, now))
    .orderBy(
      desc(collectSettings.effectiveFrom),
      desc(collectSettings.createdAt),
    )
    .limit(1);
  if (!row)
    return {
      ...COLLECT_DEFAULTS,
      reminderDays: [...COLLECT_DEFAULTS.reminderDays],
      source: 'default',
      rowId: null,
    };
  return {
    capMinor: row.capMinor,
    capDays: row.capDays,
    reminderDays: [...row.reminderDays],
    delayHours: row.delayHours,
    delayForDays: row.delayForDays,
    firstWithdrawalCapMinor: row.firstWithdrawalCapMinor,
    newDailyLimitMinor: row.newDailyLimitMinor,
    newDailyLimitDays: row.newDailyLimitDays,
    reserveWarningMinor: row.reserveWarningMinor,
    reserveCriticalMinor: row.reserveCriticalMinor,
    paused: row.paused,
    source: 'setting',
    rowId: row.id,
  };
}
