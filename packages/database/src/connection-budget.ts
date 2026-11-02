import { markServingPool, type DatabaseHandle } from './client.js';
import {
  databaseFailureOf,
  type DatabaseFailure,
} from './operations/errors.js';

export type DatabaseProcessRole = 'api' | 'worker';

/**
 * Per process. The minimum of one is safe because no code path holds a connection while asking for
 * another (test-support refuses it in every integration test). The worker's ceiling is its old
 * fixed size: it runs one statement at a time per job, so more only waits on the same provider.
 */
const BOUNDS: Record<DatabaseProcessRole, { min: number; max: number }> = {
  api: { min: 1, max: 10 },
  worker: { min: 1, max: 4 },
};
// A worker runs four jobs and two loops at once; an API copy's work is one query per request.
const WEIGHTS: Record<DatabaseProcessRole, number> = { api: 1, worker: 2 };
/** Used until the limit is read, and if it can't be. */
export const FALLBACK_POOL = 1;

export interface ServerLimits {
  maxConnections: number;
  /** superuser_reserved_connections plus reserved_connections, where the version has it. */
  reserved: number;
  /** The role's or database's own CONNECTION LIMIT; null when there is none. */
  ownLimit: number | null;
}

export interface BudgetCounts {
  apiProcesses: number;
  workerProcesses: number;
  margin: number;
}

export interface BudgetPlan {
  usable: number;
  apiPool: number;
  workerPool: number;
  /** Every process's pool full at the worst moment. */
  worstTotal: number;
  /** The minimum pools alone don't fit: expect refusals at the worst moment. */
  overcommitted: boolean;
}

/** The whole sizing rule, and nothing else: every process with the same numbers gets the same answer. */
export function planBudget(
  limits: ServerLimits,
  counts: BudgetCounts,
): BudgetPlan {
  const room = limits.maxConnections - limits.reserved - counts.margin;
  const usable = Math.max(
    0,
    limits.ownLimit === null ? room : Math.min(room, limits.ownLimit),
  );
  const unit =
    usable /
    (counts.apiProcesses * WEIGHTS.api +
      counts.workerProcesses * WEIGHTS.worker);
  const size = (role: DatabaseProcessRole) =>
    Math.min(
      BOUNDS[role].max,
      Math.max(BOUNDS[role].min, Math.floor(unit * WEIGHTS[role])),
    );
  const apiPool = size('api');
  const workerPool = size('worker');
  const worstTotal =
    counts.apiProcesses * apiPool + counts.workerProcesses * workerPool;
  return {
    usable,
    apiPool,
    workerPool,
    worstTotal,
    overcommitted: worstTotal > usable,
  };
}

export interface BudgetSnapshot {
  source: 'computed' | 'override' | 'fallback';
  role: DatabaseProcessRole;
  poolMax: number;
  /** Cut below the plan after the server refused connections. */
  reduced: boolean;
  limits: ServerLimits | null;
  plan: BudgetPlan | null;
  counts: BudgetCounts;
  /** This process, now. */
  poolTotal: number;
  poolInUse: number;
  poolWaiting: number;
  /** This role's own sessions, from the last read: exact. */
  roleSessions: number | null;
  /**
   * Named sessions in pg_stat_activity, from the last read. An upper bound on all clients: a plain
   * role sees other roles' sessions without their backend_type, and background workers can carry the
   * bootstrap role's name. Unnamed rows are background processes and take no client slot.
   */
  namedSessionsAtMost: number | null;
}

export interface AdaptiveBudget {
  /** Settled once the first read has finished or given up. Never rejects. */
  ready: Promise<void>;
  snapshot(): BudgetSnapshot;
  stop(): void;
}

const READ = `SELECT current_setting('max_connections')::int AS max_connections,
  current_setting('superuser_reserved_connections')::int AS superuser_reserved,
  COALESCE(current_setting('reserved_connections', true), '0')::int AS reserved,
  (SELECT rolconnlimit FROM pg_roles WHERE rolname = current_user) AS role_limit,
  (SELECT datconnlimit FROM pg_database WHERE datname = current_database()) AS database_limit,
  (SELECT count(*)::int FROM pg_stat_activity WHERE usename = current_user) AS role_sessions,
  (SELECT count(*)::int FROM pg_stat_activity WHERE usename IS NOT NULL) AS named_sessions`;

const FIRST_READ_MS = 3000;
const REFUSED_HOLD_MS = 60_000;

/**
 * Keeps a pool's size inside its share of the server's limit. pg-pool reads `options.max` each time
 * it decides whether to open a connection (checked in 3.14), so raising it takes effect at once and
 * no restart is needed. Lowering needs a trim, because a busy pool keeps reusing the extra clients.
 * The read goes through the pool itself, so it never costs a connection the budget didn't count.
 */
export function adaptPoolToServer(
  handle: DatabaseHandle,
  input: {
    role: DatabaseProcessRole;
    counts: BudgetCounts;
    override?: number | undefined;
    refreshMs: number;
    log: (level: 'info' | 'warn', entry: Record<string, unknown>) => void;
  },
): AdaptiveBudget {
  const { pool } = handle;
  markServingPool(pool);
  let limits: ServerLimits | null = null;
  let plan: BudgetPlan | null = null;
  let roleSessions: number | null = null;
  let namedSessions: number | null = null;
  let reducedTo: number | null = null;
  let reducedUntil = 0;
  let readFailed = false;
  let logged = '';
  let stopped = false;
  let trimming = false;
  let holdTimer: NodeJS.Timeout | undefined;

  const planned = () =>
    input.override ??
    (plan
      ? input.role === 'api'
        ? plan.apiPool
        : plan.workerPool
      : FALLBACK_POOL);

  const trim = async () => {
    if (trimming) return;
    trimming = true;
    try {
      while (!stopped && pool.totalCount > (pool.options.max ?? 0)) {
        const client = await pool.connect();
        client.release(true);
      }
    } catch {
      // Busy or unreachable: the next refresh tries again.
    } finally {
      trimming = false;
    }
  };

  const apply = () => {
    if (reducedTo !== null && Date.now() >= reducedUntil) reducedTo = null;
    const target = planned();
    pool.options.max =
      reducedTo === null ? target : Math.min(target, reducedTo);
    void trim();
    const entry = {
      source: input.override ? 'override' : plan ? 'computed' : 'fallback',
      role: input.role,
      pool_max: pool.options.max,
      reduced: reducedTo !== null,
      max_connections: limits?.maxConnections ?? null,
      reserved: limits?.reserved ?? null,
      own_limit: limits?.ownLimit ?? null,
      margin: input.counts.margin,
      usable: plan?.usable ?? null,
      api_processes: input.counts.apiProcesses,
      worker_processes: input.counts.workerProcesses,
      worst_total: plan?.worstTotal ?? null,
      overcommitted: plan?.overcommitted ?? null,
    };
    const text = JSON.stringify(entry);
    if (text !== logged) {
      logged = text;
      input.log(plan?.overcommitted ? 'warn' : 'info', {
        event: 'database.budget',
        ...entry,
      });
    }
  };

  const read = async () => {
    try {
      const { rows } = await pool.query<{
        max_connections: number;
        superuser_reserved: number;
        reserved: number;
        role_limit: number | null;
        database_limit: number | null;
        role_sessions: number;
        named_sessions: number;
      }>(READ);
      const row = rows[0];
      if (!row) throw new Error('no row');
      const own = [row.role_limit, row.database_limit].filter(
        (value): value is number => value !== null && value >= 0,
      );
      limits = {
        maxConnections: row.max_connections,
        reserved: row.superuser_reserved + row.reserved,
        ownLimit: own.length > 0 ? Math.min(...own) : null,
      };
      plan = planBudget(limits, input.counts);
      roleSessions = row.role_sessions;
      namedSessions = row.named_sessions;
      readFailed = false;
    } catch (error) {
      if (!readFailed) {
        const failure: DatabaseFailure | null = databaseFailureOf(error);
        input.log('warn', {
          event: 'database.budget_read_failed',
          cause: failure?.kind ?? 'unknown',
          ...(failure?.sqlState ? { sql_state: failure.sqlState } : {}),
          ...(failure?.errno ? { errno: failure.errno } : {}),
          keeping_pool_max: pool.options.max,
        });
      }
      readFailed = true;
    }
    apply();
  };

  handle.connectGate.onRefused = () => {
    const before = pool.options.max ?? FALLBACK_POOL;
    reducedTo = Math.max(BOUNDS[input.role].min, Math.floor(before / 2));
    reducedUntil = Date.now() + REFUSED_HOLD_MS;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(apply, REFUSED_HOLD_MS);
    holdTimer.unref();
    input.log('warn', {
      event: 'database.budget_refused',
      sql_state: '53300',
      pool_max_before: before,
      pool_max_now: reducedTo,
    });
    apply();
  };

  // A busy pool keeps reusing the extras, so trim as each one comes back: the moment it matters.
  const trimOnRelease = () => {
    if (pool.totalCount > (pool.options.max ?? 0)) void trim();
  };
  pool.on('release', trimOnRelease);
  pool.options.max = input.override ?? FALLBACK_POOL;
  let firstTimer: NodeJS.Timeout | undefined;
  const ready = Promise.race([
    read(),
    new Promise<void>((resolve) => {
      firstTimer = setTimeout(resolve, FIRST_READ_MS);
      firstTimer.unref();
    }),
  ]).finally(() => clearTimeout(firstTimer));
  const refresh = setInterval(() => void read(), input.refreshMs);
  refresh.unref();

  return {
    ready,
    snapshot: () => ({
      source: input.override ? 'override' : plan ? 'computed' : 'fallback',
      role: input.role,
      poolMax: pool.options.max ?? FALLBACK_POOL,
      reduced: reducedTo !== null,
      limits,
      plan,
      counts: input.counts,
      poolTotal: pool.totalCount,
      poolInUse: pool.totalCount - pool.idleCount,
      poolWaiting: pool.waitingCount,
      roleSessions,
      namedSessionsAtMost: namedSessions,
    }),
    stop() {
      stopped = true;
      clearInterval(refresh);
      clearTimeout(holdTimer);
      pool.off('release', trimOnRelease);
      handle.connectGate.onRefused = undefined;
    },
  };
}
