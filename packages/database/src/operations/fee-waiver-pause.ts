import { sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';

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

/** One table's known readings for the adapter, read the same way for both (indexed point reads). */
interface Source {
  signal: FeeWaiverPauseSignal;
  /** The newest known reading at or before `at` (or of all, with no `at`). */
  latest(at?: Date): Promise<Known | null>;
  /** The newest known reading at or before `at` that is not a signal. */
  latestClear(at: Date): Promise<Known | null>;
  /** The oldest known reading. */
  earliest(): Promise<Known | null>;
  /** The oldest signalling reading after `after`. */
  firstSignalAfter(after: Date): Promise<Known | null>;
  /**
   * The readings after `after` whose signal differs from the reading before them (the first one
   * always): the only rows a replay needs. The database walks the rows; only changes come back.
   */
  changesAfter(after: Date): Promise<Known[]>;
}

type Row = { id: string; read_at: Date | string; signal: boolean };
const toKnown = (r: Row): Known => ({
  id: r.id,
  readAt: r.read_at instanceof Date ? r.read_at : new Date(r.read_at),
  signal: r.signal,
});

/**
 * `table` and `signal` are constants of this file, never input. Both tables have the index
 * `(provider, currency, read_at DESC)`.
 */
function source(
  db: Database | Tx,
  provider: string,
  table: 'payment_reserve_readings' | 'collect_reserve_readings',
  known: string,
  signal: string,
  name: FeeWaiverPauseSignal,
): Source {
  const from = sql.raw(table);
  const isKnown = sql.raw(known);
  const isSignal = sql.raw(signal);
  const own = sql`provider = ${provider} AND currency = ${CURRENCY} AND ${isKnown}`;
  const one = async (where: SQL, order: 'ASC' | 'DESC') => {
    const dir = sql.raw(order);
    const { rows } = await db.execute<Row>(sql`
      SELECT id, read_at, (${isSignal}) AS signal FROM ${from}
       WHERE ${own} AND ${where}
       ORDER BY read_at ${dir}, id ${dir} LIMIT 1`);
    return rows[0] ? toKnown(rows[0]) : null;
  };
  return {
    signal: name,
    latest: (at) =>
      one(at ? sql`read_at <= ${at.toISOString()}` : sql`TRUE`, 'DESC'),
    latestClear: (at) =>
      one(sql`read_at <= ${at.toISOString()} AND NOT (${isSignal})`, 'DESC'),
    earliest: () => one(sql`TRUE`, 'ASC'),
    firstSignalAfter: (after) =>
      one(sql`read_at > ${after.toISOString()} AND (${isSignal})`, 'ASC'),
    async changesAfter(after) {
      const { rows } = await db.execute<Row>(sql`
        SELECT id, read_at, signal FROM (
          SELECT id, read_at, (${isSignal}) AS signal,
                 lag(${isSignal}) OVER (ORDER BY read_at, id) AS before
            FROM ${from}
           WHERE ${own} AND read_at > ${after.toISOString()}
        ) r
         WHERE before IS DISTINCT FROM signal
         ORDER BY read_at, id`);
      return rows.map(toKnown);
    },
  };
}

const paymentSource = (db: Database | Tx, provider: string) =>
  source(
    db,
    provider,
    'payment_reserve_readings',
    'low IS NOT NULL',
    'low',
    'payment_reserve_low',
  );

const collectSource = (db: Database | Tx, provider: string) =>
  source(
    db,
    provider,
    'collect_reserve_readings',
    'level IS NOT NULL',
    `level IN ('critical', 'breach')`,
    'collect_reserve_critical',
  );

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * How far back a spell's start is looked for. A spell longer than this reports its first
 * signalling reading inside the window: the alert stays one issue, and the work stays bounded.
 */
export const FEE_WAIVER_SPELL_LOOKBACK_DAYS = 400;
/** Steps of the walk back; each crosses one hand-over between the tables, so few are ever taken. */
const MAX_WALK_STEPS = 50;

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
 * The first signalling reading of the current spell (W14), in bounded work:
 * 1. Walk back from the newest reading to a moment when neither signal was set, by point reads:
 *    from each signalling table's last clear reading (or from before its first reading), checking
 *    the other table there. It stops at the look-back cap.
 * 2. From that moment, replay only the readings where a table's signal changed, both tables in
 *    time order, and keep the reading that last turned "neither set" into "one set".
 * Readings timestamped anywhere (a clock fault included) end it: the cap and the step limit are
 * relative to the newest reading, never to an absolute date.
 */
async function spellStart(sources: Source[], newest: Date): Promise<string> {
  const cap = new Date(
    newest.getTime() - FEE_WAIVER_SPELL_LOOKBACK_DAYS * DAY_MS,
  );
  let at = newest;
  let from: Date | null = null;
  for (let step = 0; step < MAX_WALK_STEPS && from === null; step += 1) {
    const back: number[] = [];
    for (const s of sources) {
      if ((await s.latest(at))?.signal !== true) continue;
      const clear = await s.latestClear(at);
      // Signalling since its first reading: just before that, it had none (not set).
      const first = clear ? null : await s.earliest();
      back.push(clear ? clear.readAt.getTime() : first!.readAt.getTime() - 1);
    }
    if (back.length === 0) from = at;
    else if (Math.min(...back) <= cap.getTime()) break;
    else at = new Date(Math.min(...back));
  }
  const start = from ?? cap;
  const state: boolean[] = [];
  const events: (Known & { source: number })[] = [];
  for (const [i, s] of sources.entries()) {
    state.push((await s.latest(start))?.signal === true);
    for (const r of await s.changesAfter(start))
      events.push({ ...r, source: i });
  }
  // Ties in time keep table order, then id: the same order on every call.
  events.sort(
    (a, b) =>
      a.readAt.getTime() - b.readAt.getTime() ||
      a.source - b.source ||
      a.id.localeCompare(b.id),
  );
  let found: string | null = null;
  for (const event of events) {
    const before = state.some(Boolean);
    state[event.source] = event.signal;
    if (!before && state.some(Boolean)) found = event.id;
  }
  if (found !== null) return found;
  // Paused all through the look-back: the first signalling reading inside it stands for the start.
  let earliest: Known | null = null;
  for (const s of sources) {
    const r = await s.firstSignalAfter(start);
    if (r && (earliest === null || r.readAt < earliest.readAt)) earliest = r;
  }
  if (earliest) return earliest.id;
  // Nothing after the window's start (the newest reading is at it): the newest signalling one.
  for (const s of sources) {
    const r = await s.latest();
    if (r?.signal) return r.id;
  }
  throw new Error('fee waiver pause: paused with no signalling reading');
}
