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
 * Finished scheduled runs kept in Redis: the last 100 done, and failures for a week (at most 500)
 * so they can still be looked at. With no limit every run was kept for good, and the every-minute
 * schedules filled Redis until it refused all writes (21 Nov 2026, docs/runbooks/production.md).
 * The outbox relay keeps its own 7-day window on purpose (dedupe by job ID); this is not that.
 */
export const SCHEDULED_RUN_RETENTION = {
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500, age: 7 * 24 * 3600 },
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
