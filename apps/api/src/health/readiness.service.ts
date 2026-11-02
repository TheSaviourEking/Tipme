import { Inject, Injectable } from '@nestjs/common';
import type { ReadinessResponse } from '@tipme/contracts';
import { databaseFailureOf } from '@tipme/database';
import type { Logger } from '@tipme/observability';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { PG_POOL, REDIS } from '../infra/infra.module.js';
import { withTimeout } from '../infra/timeout.js';
import { LOGGER } from '../tokens.js';

const REDIS_TIMEOUT_MS = 1000;
// A slow link to a remote database can spend this on one round trip and TLS: under the edge's 3 s
// health_timeout, which is what a late answer would be counted against.
const POSTGRES_TIMEOUT_MS = 2000;
// How long a pool with every connection in use still counts as healthy without a new query, after a
// connection last came back clean. Longer means slower to notice connections that have hung.
const BUSY_GRACE_MS = 15_000;

@Injectable()
export class ReadinessService {
  private lastHealthy = 0;
  private postgresDown = false;

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    pool.on('release', (error?: Error) => {
      if (!error) this.lastHealthy = Date.now();
    });
  }

  private draining = false;

  /** One-way: once shutdown begins this instance must never report ready again. */
  startDraining(): void {
    this.draining = true;
  }

  async check(): Promise<ReadinessResponse> {
    // Answered without touching Postgres or Redis: the load balancer polls every 2 s.
    if (this.draining) return { status: 'draining' };
    const [postgres, redis] = await Promise.all([
      this.postgres(),
      this.probe(() => this.redis.ping()),
    ]);
    const status =
      postgres === 'up' && redis === 'up' ? 'ready' : 'unavailable';
    return { status, checks: { postgres, redis } };
  }

  /**
   * The probe shares the requests' pool, so it must not read their queue as an outage: taking a busy
   * copy out of rotation would pile its traffic onto the others until they fail too. A copy that has
   * never had a clean connection (one starting in a deploy) always really asks.
   */
  private async postgres(): Promise<'up' | 'down'> {
    if (this.busyButHealthy()) return 'up';
    try {
      await withTimeout(this.pool.query('SELECT 1'), POSTGRES_TIMEOUT_MS);
      this.postgresDown = false;
      return 'up';
    } catch (error) {
      // The pool filled while the probe queued: the same thing, found a moment later.
      const failure = databaseFailureOf(error);
      if (
        (!failure || failure.kind === 'pool_wait_timeout') &&
        this.busyButHealthy()
      )
        return 'up';
      // Once per outage: this runs every 2 s. Up/down only in the response, which is public.
      if (!this.postgresDown) {
        this.logger.warn({
          event: 'readiness.postgres_down',
          cause: failure?.kind ?? 'probe_timeout',
          ...(failure?.sqlState ? { sql_state: failure.sqlState } : {}),
          ...(failure?.errno ? { errno: failure.errno } : {}),
        });
      }
      this.postgresDown = true;
      return 'down';
    }
  }

  private busyButHealthy(): boolean {
    return (
      this.pool.totalCount >= (this.pool.options.max ?? 10) &&
      this.pool.idleCount === 0 &&
      Date.now() - this.lastHealthy < BUSY_GRACE_MS
    );
  }

  // Up/down only: error details stay out of a publicly reachable response.
  private async probe(run: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await withTimeout(run(), REDIS_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
