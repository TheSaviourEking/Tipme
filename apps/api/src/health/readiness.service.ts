import { Inject, Injectable } from '@nestjs/common';
import type { ReadinessResponse } from '@tipme/contracts';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { PG_POOL, REDIS } from '../infra/infra.module.js';
import { withTimeout } from '../infra/timeout.js';

const PROBE_TIMEOUT_MS = 1000;

@Injectable()
export class ReadinessService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async check(): Promise<ReadinessResponse> {
    const [postgres, redis] = await Promise.all([
      this.probe(() => this.pool.query('SELECT 1')),
      this.probe(() => this.redis.ping()),
    ]);
    const status =
      postgres === 'up' && redis === 'up' ? 'ready' : 'unavailable';
    return { status, checks: { postgres, redis } };
  }

  // Up/down only: error details stay out of a publicly reachable response.
  private async probe(run: () => Promise<unknown>): Promise<'up' | 'down'> {
    try {
      await withTimeout(run(), PROBE_TIMEOUT_MS);
      return 'up';
    } catch {
      return 'down';
    }
  }
}
