import { z } from 'zod';

const blankIsUnset = (value: unknown) => (value === '' ? undefined : value);

/** The same settings for the API and the worker. */
export const databaseBudgetSettingsShape = {
  // Blank: size from the server's own limit. A number overrides that (an emergency, or a test).
  DATABASE_POOL_MAX: z.preprocess(
    blankIsUnset,
    z.coerce.number().int().min(1).max(50).optional(),
  ),
  // Longest wait for a connection before a clean, retryable 503 with nothing written.
  DATABASE_POOL_CONNECT_TIMEOUT_MS: z.preprocess(
    blankIsUnset,
    z.coerce.number().int().min(100).max(30000).default(5000),
  ),
  // Slots beyond the reserved ones to leave alone: the provider's own sessions (5 measured on Aiven,
  // 2 November 2026) and one-off tasks (a migration, a script, someone's psql: 2).
  DATABASE_BUDGET_MARGIN: z.preprocess(
    blankIsUnset,
    z.coerce.number().int().min(0).max(1000).default(7),
  ),
  // How many processes connect at the worst moment. The deploy config states these; unset is
  // production's count (both colours of three copies, two workers), the cautious answer.
  DATABASE_BUDGET_API_PROCESSES: z.preprocess(
    blankIsUnset,
    z.coerce.number().int().min(1).max(100).default(6),
  ),
  DATABASE_BUDGET_WORKER_PROCESSES: z.preprocess(
    blankIsUnset,
    z.coerce.number().int().min(1).max(100).default(2),
  ),
  // How often to read the limit again, so a plan change needs no restart.
  DATABASE_BUDGET_REFRESH_MS: z.preprocess(
    blankIsUnset,
    z.coerce.number().int().min(100).max(3_600_000).default(60_000),
  ),
};

/** What staff see of one API copy's share (GET /v1/ops/database-budget). */
export interface OpsDatabaseBudget {
  source: 'computed' | 'override' | 'fallback';
  role: 'api' | 'worker';
  poolMax: number;
  reduced: boolean;
  limits: {
    maxConnections: number;
    reserved: number;
    ownLimit: number | null;
  } | null;
  plan: {
    usable: number;
    apiPool: number;
    workerPool: number;
    worstTotal: number;
    overcommitted: boolean;
  } | null;
  counts: { apiProcesses: number; workerProcesses: number; margin: number };
  poolTotal: number;
  poolInUse: number;
  poolWaiting: number;
  serverClients: number | null;
}
