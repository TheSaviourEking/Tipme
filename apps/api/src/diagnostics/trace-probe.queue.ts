import { randomUUID } from 'node:crypto';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import {
  JOB_NAMES,
  JOB_QUEUE,
  traceProbeJobSchema,
  type TraceProbeMode,
  type TraceProbeStatus,
} from '@tipme/contracts';
import { injectTraceCarrier } from '@tipme/observability';
import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DependencyUnavailableError } from '../http/api-exception.filter.js';
import { REDIS } from '../infra/infra.module.js';
import { withTimeout } from '../infra/timeout.js';

const QUEUE_TIMEOUT_MS = 2000;

const states: Record<string, TraceProbeStatus['state'] | undefined> = {
  waiting: 'waiting',
  delayed: 'waiting',
  prioritized: 'waiting',
  'waiting-children': 'waiting',
  active: 'active',
  completed: 'completed',
  failed: 'failed',
};

@Injectable()
export class TraceProbeQueue implements OnApplicationShutdown {
  private readonly queue: Queue;

  constructor(
    @Inject(REDIS) redis: Redis,
    @Inject(API_CONFIG) config: ApiConfig,
  ) {
    this.queue = new Queue(JOB_QUEUE, {
      connection: redis,
      prefix: config.QUEUE_PREFIX,
    });
    this.queue.on('error', () => undefined);
  }

  async enqueue(mode: TraceProbeMode): Promise<{ jobId: string }> {
    const idempotencyKey = randomUUID();
    const payload = traceProbeJobSchema.parse({
      idempotencyKey,
      mode,
      _trace: injectTraceCarrier(),
    });
    try {
      await withTimeout(
        this.queue.add(JOB_NAMES.traceProbe, payload, {
          jobId: idempotencyKey,
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 1000 },
        }),
        QUEUE_TIMEOUT_MS,
      );
    } catch {
      throw new DependencyUnavailableError('queue unavailable');
    }
    return { jobId: idempotencyKey };
  }

  async status(jobId: string): Promise<TraceProbeStatus | null> {
    try {
      // State first, then the job: BullMQ finishes a job atomically, so once a terminal
      // state is seen the job read afterwards carries its final attempt count.
      const state =
        states[
          await withTimeout(this.queue.getJobState(jobId), QUEUE_TIMEOUT_MS)
        ];
      if (!state) return null;
      const job = await withTimeout(this.queue.getJob(jobId), QUEUE_TIMEOUT_MS);
      return job ? { state, attemptsMade: job.attemptsMade } : null;
    } catch {
      throw new DependencyUnavailableError('queue unavailable');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.queue.close().catch(() => undefined);
  }
}
