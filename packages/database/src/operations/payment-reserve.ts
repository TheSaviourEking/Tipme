import { eq, lt, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { paymentReserveReadings } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

/** While the reserve stays low (or unreadable), staff are told again this often. */
export const RESERVE_REALERT_MS = 6 * 60 * 60 * 1000;
/** A claim to send an alert that is not finished by now is a worker that died: send it again. */
export const RESERVE_CLAIM_MS = 2 * 60 * 1000;
/** Readings are kept this long; the worker purges older ones on each check. */
export const RESERVE_KEEP_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * A reading older than this means the worker has stopped checking (it reads every 15 minutes, so
 * three missed reads). The one definition: /health/payments and the staff Overview both use it.
 */
export const RESERVE_STALE_AFTER_MS = 45 * 60 * 1000;

/** Whether a reading is too old to trust that checks are still running. */
export function reserveIsStale(readAt: Date, now: Date): boolean {
  return now.getTime() - readAt.getTime() > RESERVE_STALE_AFTER_MS;
}

/** Deletes readings older than `before`; returns how many. */
export function purgeReserveReadings(
  db: Database,
  input: { before: Date },
): Promise<number> {
  return guarded(async () => {
    const deleted = await db
      .delete(paymentReserveReadings)
      .where(lt(paymentReserveReadings.readAt, input.before))
      .returning({ id: paymentReserveReadings.id });
    return deleted.length;
  });
}

/**
 * What a reserve check needs of a provider adapter: its name and the platform balance. Structural,
 * so this package never imports the adapter (ADR-0004).
 */
export interface ReserveReader {
  name: string;
  platformBalance(currency: 'NGN'): Promise<{ availableMinor: bigint }>;
}

export interface ReserveCheckResult {
  /** True below the threshold; null when the balance could not be read. */
  low: boolean | null;
  /** Whether staff were told on this check. */
  alerted: boolean;
  /** The alert could not be sent; the next check tries again. Never carries the reason. */
  alertFailed?: true;
}

const CURRENCY = 'NGN';

/** Kobo as naira text: ₦1,000 or ₦999.99. */
export function nairaText(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const kobo = abs % 100n;
  return `${negative ? '-' : ''}₦${whole}${kobo === 0n ? '' : `.${kobo.toString().padStart(2, '0')}`}`;
}

/**
 * The claim section both reserve checks share (Task 11): under the caller's advisory lock, whether
 * to send this kind of alert now. Not when one is being sent (a claim younger than
 * RESERVE_CLAIM_MS with no `alerted_at`), nor when one was sent in the current spell (since the last
 * reading matching `fine`) less than RESERVE_REALERT_MS ago. Null for no; 'first' for the spell's
 * first alert, 'again' for a repeat. The caller then inserts its reading with `alert_claimed_at`.
 */
export async function claimReserveAlert(
  tx: Tx,
  i: {
    table: 'payment_reserve_readings' | 'collect_reserve_readings';
    provider: string;
    currency: string;
    kind: SQL;
    fine: SQL;
    now: Date;
  },
): Promise<'first' | 'again' | null> {
  const table = sql.identifier(i.table);
  const [state] = (
    await tx.execute(sql`
      SELECT max(alerted_at) AS last_alert,
             coalesce(bool_or(alerted_at IS NULL
               AND alert_claimed_at > ${new Date(i.now.getTime() - RESERVE_CLAIM_MS).toISOString()}::timestamptz), false) AS in_flight
        FROM ${table}
       WHERE provider = ${i.provider} AND currency = ${i.currency}
         AND ${i.kind}
         AND read_at > coalesce(
           (SELECT max(read_at) FROM ${table}
             WHERE provider = ${i.provider} AND currency = ${i.currency} AND ${i.fine}),
           '-infinity'::timestamptz)`)
  ).rows as { last_alert: string | Date | null; in_flight: boolean }[];
  if (state?.in_flight) return null;
  const lastAlert = state?.last_alert ? new Date(state.last_alert) : null;
  if (!lastAlert) return 'first';
  return i.now.getTime() - lastAlert.getTime() >= RESERVE_REALERT_MS
    ? 'again'
    : null;
}

/**
 * Reads the platform reserve, records the reading, and tells staff through `alert`: at the first
 * low reading after a normal one, and again every 6 hours while it stays low. A balance that
 * cannot be read is recorded as unknown and alerts the same way, as "unreadable", with its own
 * first alert and its own 6 hours. Alert text names no secret and no error: only the provider
 * adapter name (staff alerts may name providers) and, when known, the amount.
 *
 * Safe to run twice at once. The decision and the reading's insert happen in one short
 * transaction under an advisory lock per provider; the winner records a claim on its reading
 * before it sends, and the lock is let go before the (slow) send, so the other run sees the claim
 * and sends nothing. The provider read and the alert call are never made while the lock is held.
 * A send that fails gives the claim back, so the next check (15 minutes later) tries again; a
 * worker that dies mid-send leaves a claim that lapses after RESERVE_CLAIM_MS and is sent again
 * (at least once).
 */
export function checkReserve(
  db: Database,
  input: {
    provider: ReserveReader;
    thresholdMinor: bigint;
    alert: (text: string) => Promise<void>;
    now?: Date;
  },
): Promise<ReserveCheckResult> {
  const now = input.now ?? new Date();
  const { thresholdMinor } = input;
  const provider = input.provider.name;
  return guarded(async () => {
    // A failed read is a normal answer ("unknown"), and its error is never kept or shown: it may
    // carry request details.
    const available = await input.provider
      .platformBalance(CURRENCY)
      .then((balance) => balance.availableMinor)
      .catch(() => null);
    const low = available === null ? null : available < thresholdMinor;

    const id = newId();
    const claimed = await db.transaction(async (tx) => {
      // Waits at most a moment: the section below is a few quick statements.
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`payment_reserve:${provider}`}::text))`,
      );
      const claim =
        low !== false &&
        (await claimReserveAlert(tx, {
          table: 'payment_reserve_readings',
          provider,
          currency: CURRENCY,
          // This kind of alert (low, or unreadable), in the current spell: since the last fine one.
          kind: low === null ? sql`low IS NULL` : sql`low = true`,
          fine: sql`low = false`,
          now,
        })) !== null;
      await tx.insert(paymentReserveReadings).values({
        id,
        provider,
        currency: CURRENCY,
        availableMinor: available,
        thresholdMinor,
        low,
        readAt: now,
        alertClaimedAt: claim ? now : null,
      });
      return claim;
    });
    if (!claimed) return { low, alerted: false };

    const text =
      available === null
        ? `Payment reserve (${provider}) could not be read, so it may be low. Check the provider and the worker.`
        : `Payment reserve (${provider}) is low: ${nairaText(available)} available, below the ${nairaText(thresholdMinor)} alert level. Top it up so payout fees can be paid.`;
    try {
      await input.alert(text);
    } catch {
      // Reason dropped on purpose: a webhook error can quote the address. Give the claim back so
      // the next check sends it.
      await db
        .update(paymentReserveReadings)
        .set({ alertClaimedAt: null })
        .where(eq(paymentReserveReadings.id, id));
      return { low, alerted: false, alertFailed: true as const };
    }
    await db
      .update(paymentReserveReadings)
      .set({ alertedAt: now })
      .where(eq(paymentReserveReadings.id, id));
    return { low, alerted: true };
  });
}

export interface ReserveReading {
  provider: string;
  currency: string;
  availableMinor: bigint | null;
  thresholdMinor: bigint;
  low: boolean | null;
  readAt: Date;
}

/** The newest reading of any provider (a copy reads only its own), or null before the first. */
export function latestReserveReading(
  db: Database,
): Promise<ReserveReading | null> {
  return guarded(async () => {
    const [row] = await db
      .select()
      .from(paymentReserveReadings)
      // NULLS LAST as in the index's definition: a bare DESC would not use it and sorts the table.
      .orderBy(sql`${paymentReserveReadings.readAt} DESC NULLS LAST`)
      .limit(1);
    return row
      ? {
          provider: row.provider,
          currency: row.currency,
          availableMinor: row.availableMinor,
          thresholdMinor: row.thresholdMinor,
          low: row.low,
          readAt: row.readAt,
        }
      : null;
  });
}
