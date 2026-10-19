import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { JOB_NAMES, JOB_QUEUE, traceCarrierSchema } from '@tipme/contracts';
import {
  createLogger,
  getMeter,
  withExtractedContext,
  type DestinationStream,
} from '@tipme/observability';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import {
  autoResolveIssues,
  createDatabase,
  evaluatePeriodMoments,
  expireStaleTips,
  previousIsoWeek,
  runWeeklyReports,
  reconcileAttempts,
  reconcilePayouts,
  runIssueDetectors,
  lagosDaysBefore,
  purgeAnalytics,
  rollupAnalytics,
} from '@tipme/database';
import { createMockProvider } from '@tipme/payments';
import { Redis } from 'ioredis';
import { closeWithin } from './close-within.js';
import { ensureSchedule } from './ensure-schedule.js';
import { SERVICE_NAME, type WorkerConfig } from './config.js';
import {
  DOMAIN_EVENT_NAMES,
  handleDomainEvent,
} from './handlers/domain-events.js';
import { handleTraceProbe } from './handlers/trace-probe.js';
import { startOutboxRelay } from './outbox-relay-loop.js';

const RECONCILE_JOB = 'reconcile.payments';
const WEEKLY_REPORTS_JOB = 'reports.weekly';
const MONTHLY_MOMENTS_JOB = 'moments.monthly';
const ANALYTICS_DAILY_JOB = 'analytics.daily';
const ANALYTICS_RETENTION_MS = 90 * 86_400_000;

/** The calendar month (Lagos) before `now`, as YYYY-MM. */
function previousMonth(now: Date): string {
  const [year, month] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
  })
    .format(now)
    .split('-')
    .map(Number) as [number, number];
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
const JOB_TIMEOUT_MS = 5000;
const DRAIN_TIMEOUT_MS = 10_000;
const PROCESSED_TTL_SECONDS = 86_400;
// Only these failure reasons are logged verbatim; anything else is logged by error name.
const knownReasons = new Set([
  'probe_failure',
  'timeout',
  'invalid_payload',
  'unknown_job',
]);

export interface JobWorker {
  close(): Promise<void>;
}

export interface JobWorkerOptions {
  logDestination?: DestinationStream;
}

export async function startJobWorker(
  config: WorkerConfig,
  options: JobWorkerOptions = {},
): Promise<JobWorker> {
  const logger = createLogger({
    service: SERVICE_NAME,
    level: config.LOG_LEVEL,
    destination: options.logDestination,
  });
  const tracer = trace.getTracer(SERVICE_NAME);
  const processed = getMeter(SERVICE_NAME).createCounter(
    'tipme.jobs.processed',
    {
      description: 'Jobs finished, by outcome',
    },
  );
  // BullMQ workers need blocking commands to wait indefinitely.
  const connection = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: null,
  });
  connection.on('error', () => undefined);
  // Separate, fail-fast client: marker and count commands must not queue forever while Redis is down.
  const markers = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  markers.on('error', () => undefined);
  const queue = new Queue(JOB_QUEUE, {
    connection: markers,
    prefix: config.QUEUE_PREFIX,
  });
  const database = createDatabase(config.DATABASE_URL, { max: 4 });
  const analyticsEnabled =
    config.ANALYTICS_ENABLED ?? config.NODE_ENV !== 'production';
  // Reconciliation asks the provider (never charges); it shares the fail-fast Redis client.
  // The worker only asks the provider for statuses; without a secret it can never accept webhooks.
  const provider = createMockProvider({
    redis: markers,
    prefix: config.QUEUE_PREFIX,
  });
  const schedule = ensureSchedule({
    queue,
    id: RECONCILE_JOB,
    every: config.RECONCILE_INTERVAL_MS,
    logger,
  });
  // Monday 07:00 in Lagos: last week's reports (PR-008).
  const weeklySchedule = ensureSchedule({
    queue,
    id: WEEKLY_REPORTS_JOB,
    repeat: { pattern: '0 7 * * 1', tz: 'Africa/Lagos' },
    logger,
  });
  // The 1st of each month, 07:00 in Lagos: "best month so far".
  const monthlySchedule = ensureSchedule({
    queue,
    id: MONTHLY_MOMENTS_JOB,
    repeat: { pattern: '0 7 1 * *', tz: 'Africa/Lagos' },
    logger,
  });
  // 01:00 in Lagos: yesterday's analytics totals (re-done for 3 days), and the 90-day purge.
  const analyticsSchedule = ensureSchedule({
    queue,
    id: ANALYTICS_DAILY_JOB,
    repeat: { pattern: '0 1 * * *', tz: 'Africa/Lagos' },
    logger,
  });
  queue.on('error', () => undefined);

  const meter = getMeter(SERVICE_NAME);
  const waiting = meter.createObservableGauge('tipme.jobs.waiting');
  const failed = meter.createObservableGauge('tipme.jobs.failed');
  meter.addBatchObservableCallback(
    async (observer) => {
      const counts = await queue
        .getJobCounts('waiting', 'failed')
        .catch(() => undefined);
      if (!counts) return;
      observer.observe(waiting, counts['waiting'] ?? 0);
      observer.observe(failed, counts['failed'] ?? 0);
    },
    [waiting, failed],
  );

  const markerKey = (key: string) => `${config.QUEUE_PREFIX}:processed:${key}`;
  const isProcessed = async (key: string): Promise<boolean> =>
    (await markers.exists(markerKey(key))) === 1;
  const markProcessed = async (key: string): Promise<boolean> =>
    (await markers.set(
      markerKey(key),
      '1',
      'EX',
      PROCESSED_TTL_SECONDS,
      'NX',
    )) === 'OK';

  const run = (job: Job) =>
    tracer.startActiveSpan(
      `job ${job.name}`,
      {
        kind: SpanKind.CONSUMER,
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.destination.name': JOB_QUEUE,
          'tipme.job.attempt': job.attemptsMade + 1,
        },
      },
      async (span) => {
        const fields = { job_name: job.name, attempt: job.attemptsMade + 1 };
        try {
          if (job.name === RECONCILE_JOB) {
            const now = new Date();
            const payments = await reconcileAttempts({
              db: database.db,
              provider,
              now,
              minAgeMs: config.RECONCILE_MIN_AGE_MS,
            });
            const payoutResult = await reconcilePayouts({
              db: database.db,
              provider,
              now,
              minAgeMs: config.RECONCILE_MIN_AGE_MS,
            });
            // Never-paid tips are cancelled, after the provider confirms they were not paid.
            const expiry = await expireStaleTips({
              db: database.db,
              provider,
              now,
            });
            // Then the admin inbox: open issues for what still needs a person, close cleared ones.
            const detected = await runIssueDetectors(database.db, now);
            const cleared = await autoResolveIssues(database.db, now);
            logger.info({
              event: 'reconcile.completed',
              issues_opened: detected.opened,
              issues_auto_resolved: cleared.resolved,
              ...payments,
              payouts_checked: payoutResult.checked,
              payouts_applied: payoutResult.applied,
              payouts_errors: payoutResult.errors,
              expired: expiry.expired,
              expired_paid: expiry.paid,
              expire_errors: expiry.errors,
            });
            processed.add(1, { outcome: 'reconciled' });
            return 'reconciled';
          }
          if (job.name === WEEKLY_REPORTS_JOB) {
            const isoWeek = previousIsoWeek(new Date());
            // Moments first, so the report can show "best week so far".
            await evaluatePeriodMoments(database.db, {
              period: 'week',
              periodKey: isoWeek,
              now: new Date(),
              budgetPerMonthMinor: config.REWARD_CASH_BUDGET_MINOR_PER_MONTH,
            });
            const { created } = await runWeeklyReports(database.db, {
              isoWeek,
            });
            logger.info({
              event: 'reports.weekly.completed',
              iso_week: isoWeek,
              created,
            });
            processed.add(1, { outcome: 'reported' });
            return 'reported';
          }
          if (job.name === MONTHLY_MOMENTS_JOB) {
            const now = new Date();
            const { created } = await evaluatePeriodMoments(database.db, {
              period: 'month',
              periodKey: previousMonth(now),
              now,
              budgetPerMonthMinor: config.REWARD_CASH_BUDGET_MINOR_PER_MONTH,
            });
            logger.info({ event: 'moments.monthly.completed', created });
            processed.add(1, { outcome: 'celebrated' });
            return 'celebrated';
          }
          if (job.name === ANALYTICS_DAILY_JOB) {
            const now = new Date();
            for (const date of lagosDaysBefore(now, 3))
              await rollupAnalytics(database.db, { date });
            const purged = await purgeAnalytics(database.db, {
              before: new Date(now.getTime() - ANALYTICS_RETENTION_MS),
            });
            logger.info({ event: 'analytics.daily.completed', purged });
            processed.add(1, { outcome: 'rolled_up' });
            return 'rolled_up';
          }
          if (DOMAIN_EVENT_NAMES.has(job.name)) {
            const outcome = await handleDomainEvent(job.name, job.data, {
              db: database.db,
              logger,
              rewardBudgetPerMonthMinor:
                config.REWARD_CASH_BUDGET_MINOR_PER_MONTH,
              dedupeKey: job.id,
              analyticsEnabled,
            });
            processed.add(1, { outcome });
            return outcome;
          }
          if (job.name !== JOB_NAMES.traceProbe)
            throw new UnrecoverableError('unknown_job');
          const outcome = await handleTraceProbe(job.data, {
            attemptsMade: job.attemptsMade,
            isProcessed,
            markProcessed,
            signal: AbortSignal.timeout(JOB_TIMEOUT_MS),
            delayMs: config.TRACE_PROBE_TEST_DELAY_MS,
          });
          logger.info({
            event: outcome === 'processed' ? 'job.completed' : 'job.duplicate',
            ...fields,
          });
          processed.add(1, { outcome });
          return outcome;
        } catch (error) {
          const reason =
            error instanceof Error && knownReasons.has(error.message)
              ? error.message
              : error instanceof Error
                ? error.name
                : 'unknown';
          logger.warn({ event: 'job.failed', reason, ...fields });
          span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
          processed.add(1, { outcome: 'failed' });
          throw error;
        } finally {
          span.end();
        }
      },
    );

  const worker = new Worker(
    JOB_QUEUE,
    (job: Job) => {
      // Continue the producer's trace when the carrier is valid; otherwise start a new one.
      const carrier = traceCarrierSchema.safeParse(
        (job.data as { _trace?: unknown } | null)?._trace,
      );
      return carrier.success
        ? withExtractedContext(carrier.data, () => run(job))
        : run(job);
    },
    { connection, prefix: config.QUEUE_PREFIX, concurrency: 4 },
  );
  worker.on('error', (error) =>
    logger.warn({ event: 'worker.error', error: error.name }),
  );
  const relay = startOutboxRelay({ db: database.db, queue, logger });

  return {
    async close() {
      await schedule.stop();
      await weeklySchedule.stop();
      await monthlySchedule.stop();
      await analyticsSchedule.stop();
      await relay.stop();
      // Let in-flight jobs finish, but never wait forever: a hung close is abandoned.
      await closeWithin(
        DRAIN_TIMEOUT_MS,
        () => worker.close(),
        async () => {
          void worker.close(true).catch(() => undefined);
        },
      );
      await queue.close().catch(() => undefined);
      markers.disconnect();
      connection.disconnect();
      await database.close().catch(() => undefined);
    },
  };
}
