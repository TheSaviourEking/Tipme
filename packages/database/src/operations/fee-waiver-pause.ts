import { and, asc, desc, eq, gt, isNotNull, lte } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { collectReserveReadings, paymentReserveReadings } from '../schema.js';

/*
 * Fee waivers (spec 2026-11-23 §5, W6): tip waivers pause while TipMe's own balance at the active
 * partner reads low, since waived processing is charged to that balance (ADR-0004). Either reading
 * pauses: the payments reserve reading `low` (direct tips), or the You collect reserve reading
 * `critical` or `breach`. Only KNOWN readings count (ruling R11): an unknown one (a failed read)
 * neither starts nor ends a pause, and no known reading at all is not paused, so mock copies and
 * tests never are.
 */

export type FeeWaiverPauseSignal =
  'payment_reserve_low' | 'collect_reserve_critical';

export interface FeeWaiverPause {
  paused: boolean;
  signals: FeeWaiverPauseSignal[];
  /**
   * While paused, the first signalling reading after the last moment neither signal was set (W14):
   * one id for the whole spell, whichever table it is in. Null when not paused.
   */
  spellStartReadingId: string | null;
}

/** The readings are of the NGN balance: the only currency the partner pays fees in (W6). */
const CURRENCY = 'NGN';
const COLLECT_PAUSING = ['critical', 'breach'] as const;
const NOT_PAUSED: FeeWaiverPause = {
  paused: false,
  signals: [],
  spellStartReadingId: null,
};

interface Known {
  id: string;
  readAt: Date;
  signal: boolean;
}

/** One table's known readings for the adapter, read the same way for both. */
interface Source {
  signal: FeeWaiverPauseSignal;
  /** The newest known reading at or before `at` (or of all, with no `at`). */
  latest(at?: Date): Promise<Known | null>;
  /** Known readings after `after`, oldest first. */
  since(after: Date): Promise<Known[]>;
}

function paymentSource(db: Database | Tx, provider: string): Source {
  const t = paymentReserveReadings;
  const columns = { id: t.id, readAt: t.readAt, low: t.low };
  const own = and(
    eq(t.provider, provider),
    eq(t.currency, CURRENCY),
    isNotNull(t.low),
  );
  const known = (r: { id: string; readAt: Date; low: boolean | null }) => ({
    id: r.id,
    readAt: r.readAt,
    signal: r.low === true,
  });
  return {
    signal: 'payment_reserve_low',
    async latest(at) {
      const [row] = await db
        .select(columns)
        .from(t)
        .where(at ? and(own, lte(t.readAt, at)) : own)
        .orderBy(desc(t.readAt), desc(t.id))
        .limit(1);
      return row ? known(row) : null;
    },
    async since(after) {
      const rows = await db
        .select(columns)
        .from(t)
        .where(and(own, gt(t.readAt, after)))
        .orderBy(asc(t.readAt), asc(t.id));
      return rows.map(known);
    },
  };
}

function collectSource(db: Database | Tx, provider: string): Source {
  const t = collectReserveReadings;
  const columns = { id: t.id, readAt: t.readAt, level: t.level };
  const own = and(
    eq(t.provider, provider),
    eq(t.currency, CURRENCY),
    isNotNull(t.level),
  );
  const known = (r: { id: string; readAt: Date; level: string | null }) => ({
    id: r.id,
    readAt: r.readAt,
    signal: (COLLECT_PAUSING as readonly (string | null)[]).includes(r.level),
  });
  return {
    signal: 'collect_reserve_critical',
    async latest(at) {
      const [row] = await db
        .select(columns)
        .from(t)
        .where(at ? and(own, lte(t.readAt, at)) : own)
        .orderBy(desc(t.readAt), desc(t.id))
        .limit(1);
      return row ? known(row) : null;
    },
    async since(after) {
      const rows = await db
        .select(columns)
        .from(t)
        .where(and(own, gt(t.readAt, after)))
        .orderBy(asc(t.readAt), asc(t.id));
      return rows.map(known);
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Before the first reading any copy can hold (the reserve checks began in 2026). */
const EPOCH_BEFORE_READINGS = Date.UTC(2000, 0, 1);

/**
 * Whether tip waivers are paused for the active adapter (`PAYMENT_PROVIDER`), and since which
 * reading. A missing or empty provider reads as no reading: not paused (ruling R7), never a SQL
 * `= NULL` match.
 */
export async function feeWaiversPaused(
  db: Database | Tx,
  input: { activeProvider: string },
): Promise<FeeWaiverPause> {
  const now = await currentSignals(db, input.activeProvider);
  if (now === null) return NOT_PAUSED;
  return {
    paused: true,
    signals: now.signals,
    spellStartReadingId: await spellStart(now.sources, now.newest),
  };
}

/** Whether tip waivers are paused now: the quote's question, without the spell's start. */
export async function tipWaiversPausedNow(
  db: Database | Tx,
  activeProvider: string,
): Promise<boolean> {
  return (await currentSignals(db, activeProvider)) !== null;
}

/** The signals set by each table's latest known reading; null when none is (or no provider). */
async function currentSignals(
  db: Database | Tx,
  provider: string,
): Promise<{
  signals: FeeWaiverPauseSignal[];
  sources: Source[];
  newest: Date;
} | null> {
  // Callers that pass no provider (most .mjs tests) get "no reading", never a SQL `= NULL`.
  if (typeof provider !== 'string' || provider === '') return null;
  const sources = [paymentSource(db, provider), collectSource(db, provider)];
  // One after the other: a transaction is one connection.
  const latest: (Known | null)[] = [];
  for (const source of sources) latest.push(await source.latest());
  const signals = sources
    .filter((_, i) => latest[i]?.signal === true)
    .map((s) => s.signal);
  if (signals.length === 0) return null;
  const newest = Math.max(...latest.map((r) => r?.readAt.getTime() ?? 0));
  return { signals, sources, newest: new Date(newest) };
}

/**
 * The first signalling reading of the current spell: replays both tables' known readings in time
 * order from a window's start, with each table's state at that start, and keeps the reading that
 * last turned "neither set" into "one set". A window still paused at its start is widened until
 * it is not (or holds every reading), so the cost follows the spell, not the history.
 */
async function spellStart(sources: Source[], newest: Date): Promise<string> {
  for (let days = 1; ; days *= 8) {
    // Past every possible reading, the window starts with neither set, so the loop ends.
    const from = new Date(
      Math.max(newest.getTime() - days * DAY_MS, EPOCH_BEFORE_READINGS),
    );
    const state: boolean[] = [];
    const events: (Known & { source: number })[] = [];
    for (const [i, source] of sources.entries()) {
      state.push((await source.latest(from))?.signal === true);
      for (const r of await source.since(from))
        events.push({ ...r, source: i });
    }
    // Ties in time keep table order, then id: the same order on every call.
    events.sort(
      (a, b) =>
        a.readAt.getTime() - b.readAt.getTime() ||
        a.source - b.source ||
        a.id.localeCompare(b.id),
    );
    let start: string | null = null;
    for (const event of events) {
      const before = state.some(Boolean);
      state[event.source] = event.signal;
      const after = state.some(Boolean);
      if (!before && after) start = event.id;
    }
    if (start !== null) return start;
    // Paused all through the window: the spell began earlier, so look further back.
    // (A window from before any reading starts with neither set; this is only a backstop.)
    if (from.getTime() === EPOCH_BEFORE_READINGS) {
      const first = events.find((e) => e.signal);
      if (first) return first.id;
    }
  }
}
