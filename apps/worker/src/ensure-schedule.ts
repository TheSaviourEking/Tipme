import type { JobSchedulerTemplateOptions } from 'bullmq';

/** Every N milliseconds, or a cron pattern in a time zone (e.g. Monday 07:00 in Lagos). */
export type ScheduleRepeat =
  { every: number } | { pattern: string; tz: string };

interface Scheduler {
  upsertJobScheduler(
    id: string,
    repeat: ScheduleRepeat,
    template: {
      name: string;
      opts: JobSchedulerTemplateOptions;
    },
  ): Promise<unknown>;
}

/**
 * What happens to a finished scheduled run. With no options every run stayed in Redis for good,
 * and the every-minute schedules filled it until it refused all writes (21 Nov 2026,
 * docs/runbooks/production.md §12).
 *
 * No `count` on purpose: BullMQ applies a count to the queue's WHOLE completed or failed set, and
 * the outbox relay's jobs share this queue and must stay 7 days (their job ID is the dedupe key).
 * `true` removes only the run that finished. A failed run is kept 7 days, the relay's own age, so
 * trimming by age never removes a relay job sooner than it would go anyway. The cost: no cap on
 * failed runs, so a week of every schedule failing could keep about 100k (watch tipme.jobs.failed).
 */
export const SCHEDULED_RUN_RETENTION = {
  removeOnComplete: true,
  removeOnFail: { age: 7 * 24 * 3600 },
} satisfies JobSchedulerTemplateOptions;

/**
 * Registers a repeatable job, retrying with backoff until it succeeds (e.g. Redis was briefly
 * down at startup), so a worker never runs for its whole life without its schedule.
 */
export function ensureSchedule(options: {
  queue: Scheduler;
  id: string;
  every?: number;
  repeat?: ScheduleRepeat;
  logger: { warn(fields: object): void };
  retryMs?: number;
  maxRetryMs?: number;
}): { ready: Promise<void>; stop(): Promise<void> } {
  const {
    queue,
    id,
    every,
    repeat = { every: every ?? 60_000 },
    logger,
    retryMs = 1000,
    maxRetryMs = 30_000,
  } = options;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const ready = new Promise<void>((resolve) => {
    let delay = retryMs;
    const attempt = (): void => {
      if (stopped) return resolve();
      queue
        .upsertJobScheduler(id, repeat, {
          name: id,
          opts: SCHEDULED_RUN_RETENTION,
        })
        .then(
          () => resolve(),
          () => {
            logger.warn({ event: 'schedule.retry', schedule: id });
            timer = setTimeout(attempt, delay);
            delay = Math.min(delay * 2, maxRetryMs);
          },
        );
    };
    attempt();
  });
  return {
    ready,
    async stop() {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
