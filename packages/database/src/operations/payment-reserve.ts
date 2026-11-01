import { desc, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { paymentReserveReadings } from '../schema.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';

/** While the reserve stays low (or unreadable), staff are told again this often. */
export const RESERVE_REALERT_MS = 6 * 60 * 60 * 1000;

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
 * Reads the platform reserve, records the reading, and tells staff through `alert`: at the first
 * low reading after a normal one, and again every 6 hours while it stays low. A balance that
 * cannot be read is recorded as unknown and alerts the same way, as "unreadable", with its own
 * first alert and its own 6 hours. Alert text names no secret and no error: only the provider
 * adapter name (staff alerts may name providers) and, when known, the amount.
 *
 * An alert that fails is not thrown: the reading is kept without `alerted_at`, so the next check
 * (15 minutes later) tries again. The caller must not run two checks at once; the worker holds a
 * lock for that.
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

    let alertedAt: Date | null = null;
    let alertFailed = false;
    if (low !== false) {
      // When this kind of alert (low, or unreadable) was last sent in the current spell: since the
      // last reading that was fine.
      const [last] = (
        await db.execute(sql`
          SELECT max(alerted_at) AS at FROM payment_reserve_readings
           WHERE provider = ${provider} AND currency = ${CURRENCY}
             AND alerted_at IS NOT NULL
             AND ${low === null ? sql`low IS NULL` : sql`low = true`}
             AND read_at > coalesce(
               (SELECT max(read_at) FROM payment_reserve_readings
                 WHERE provider = ${provider} AND currency = ${CURRENCY} AND low = false),
               '-infinity'::timestamptz)`)
      ).rows as { at: string | Date | null }[];
      const lastAt = last?.at ? new Date(last.at) : null;
      if (!lastAt || now.getTime() - lastAt.getTime() >= RESERVE_REALERT_MS) {
        const text =
          available === null
            ? `Payment reserve (${provider}) could not be read, so it may be low. Check the provider and the worker.`
            : `Payment reserve (${provider}) is low: ${nairaText(available)} available, below the ${nairaText(thresholdMinor)} alert level. Top it up so payout fees can be paid.`;
        try {
          await input.alert(text);
          alertedAt = now;
        } catch {
          // Reason dropped on purpose: a webhook error can quote the address.
          alertFailed = true;
        }
      }
    }

    await db.insert(paymentReserveReadings).values({
      id: newId(),
      provider,
      currency: CURRENCY,
      availableMinor: available,
      thresholdMinor,
      low,
      readAt: now,
      alertedAt,
    });
    return {
      low,
      alerted: alertedAt !== null,
      ...(alertFailed ? { alertFailed: true as const } : {}),
    };
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
      .orderBy(desc(paymentReserveReadings.readAt))
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
