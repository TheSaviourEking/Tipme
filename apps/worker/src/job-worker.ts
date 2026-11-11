import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import {
  JOB_NAMES,
  JOB_QUEUE,
  PAYOUT_START_EVENT,
  PLATFORM_REFUSAL_EVENT,
  WITHDRAWAL_FREEZE_OPENED_EVENT,
  WITHDRAWALS_SWITCH_EVENT,
  liveChannel,
  traceCarrierSchema,
} from '@tipme/contracts';
import {
  createErrorReporter,
  createLogger,
  getMeter,
  withExtractedContext,
  type DestinationStream,
} from '@tipme/observability';
import { configuredMailProviders, type MailProviderName } from '@tipme/mail';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import {
  adaptPoolToServer,
  autoResolveIssues,
  expireRequests,
  createDatabase,
  expireStalePaymentAccountCreations,
  expireStaleAttemptStarts,
  evaluatePeriodMoments,
  expireStaleTips,
  previousIsoWeek,
  activeMailProvider,
  mailOverrideFor,
  mailSealing,
  pretendMailSink,
  runWeeklyReports,
  runMonthlyRecaps,
  reconcileAttempts,
  reconcilePayouts,
  reconcileProPurchases,
  reconcileProCollections,
  runShareTransfers,
  renewProAutomatically,
  sendProRefunds,
  sweepPayoutSetup,
  runIssueDetectors,
  lagosDaysBefore,
  purgeAnalytics,
  purgeProfileReports,
  sweepRehearsals,
  rollupAnalytics,
  registerRealSeriousActions,
  businessLiveAudience,
} from '@tipme/database';
import {
  createBachsProvider,
  createMockProvider,
  type BachsProvider,
  type MockProvider,
  wiredPaymentProvider,
} from '@tipme/payments';
import { Redis } from 'ioredis';
import { closeWithin } from './close-within.js';
import { ensureSchedule } from './ensure-schedule.js';
import { SERVICE_NAME, type WorkerConfig } from './config.js';
import {
  DOMAIN_EVENT_NAMES,
  handleDomainEvent,
  staffAlertPoster,
} from './handlers/domain-events.js';
import {
  handlePaymentReserve,
  warnIfNoAlertRoute,
} from './handlers/payment-reserve.js';
import { handlePlatformRefusal } from './handlers/platform-refusal.js';
import { handleWithdrawalFreezeOpened } from './handlers/withdrawal-freeze.js';
import { handlePayoutStart } from './handlers/payout-start.js';
import { handleTraceProbe } from './handlers/trace-probe.js';
import { startMailDelivery } from './mail-delivery-loop.js';
import { startOutboxRelay } from './outbox-relay-loop.js';
import { createWorkerLivePublisher } from './live-publisher.js';
import {
  jobSignalsFor,
  PAYOUT_SETUP_JOB_NAME,
  WEEKLY_REPORTS_JOB_NAME,
  businessTipSignals,
} from './live-signals.js';
import { handleWithdrawalsSwitchChanged } from './handlers/withdrawals-switch.js';
import { handleUsernameTakeBacks } from './handlers/username-take-backs.js';
import { handleProExpire, handleProReminders } from './handlers/pro.js';
import { workerRevalidator } from './revalidate.js';
import { databaseFailureFields, jobFailure } from './job-retry.js';
import { runUnlessRunning } from './run-lock.js';

const RECONCILE_JOB = 'reconcile.payments';
const WEEKLY_REPORTS_JOB = WEEKLY_REPORTS_JOB_NAME;
const MONTHLY_MOMENTS_JOB = 'moments.monthly';
const ANALYTICS_DAILY_JOB = 'analytics.daily';
const REHEARSAL_SWEEP_JOB = 'rehearsals.sweep';
const APPROVALS_EXPIRE_JOB = 'approvals.expire';
const USERNAME_TAKE_BACKS_JOB = 'usernames.take-backs';
// Paid Pro (ADR-0015): months move on every minute; reminders every 15 minutes.
const PRO_EXPIRE_JOB = 'pro.expire';
const PRO_REMINDERS_JOB = 'pro.reminders';
// Auto-renew (plan Task 10): a day before a month ends, every 15 minutes, only with PRO_AUTO_RENEW.
const PRO_RENEW_JOB = 'pro.renew';
const PAYOUT_SETUP_JOB = PAYOUT_SETUP_JOB_NAME;
const PAYOUT_SETUP_INTERVAL_MS = 15 * 60_000;
// A long sweep (a backlog, or a slow provider) must not run beside the next one. Under the interval
// so a run lost with its worker costs at most one missed turn.
const PAYOUT_SETUP_LOCK_TTL_MS = 14 * 60_000;
const PAYMENT_RESERVE_JOB = 'payments.reserve';
const PAYMENT_RESERVE_INTERVAL_MS = 15 * 60_000;
// A reserve check takes seconds (the provider client gives up within 10 s, so does the alert). The
// lock outlasts any run and frees itself well before the next one if the process dies mid-run.
const PAYMENT_RESERVE_LOCK_TTL_MS = 5 * 60_000;
/** A release check takes minutes: anything still tagged after this was left behind. */
const REHEARSAL_GRACE_MS = 2 * 3_600_000;
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

/**
 * The worker's Bachs reader for the configured provider: that environment's key only, and no
 * webhook secret, so it can ask for statuses but never accept a webhook. Fails startup for a
 * provider this build cannot run (never a silent mock).
 */
export function workerBachsProvider(
  config: Pick<
    WorkerConfig,
    'PAYMENT_PROVIDER' | 'BACHS_SANDBOX_API_KEY' | 'BACHS_LIVE_API_KEY'
  >,
): BachsProvider | null {
  const name = wiredPaymentProvider(config.PAYMENT_PROVIDER);
  switch (name) {
    case 'bachs-live':
      if (!config.BACHS_LIVE_API_KEY)
        throw new Error('BACHS_LIVE_API_KEY is required for Bachs live');
      return createBachsProvider({
        apiKey: config.BACHS_LIVE_API_KEY,
        environment: 'live',
      });
    case 'bachs-sandbox':
      if (!config.BACHS_SANDBOX_API_KEY)
        throw new Error('BACHS_SANDBOX_API_KEY is required for Bachs sandbox');
      return createBachsProvider({
        apiKey: config.BACHS_SANDBOX_API_KEY,
        environment: 'sandbox',
      });
    case 'mock':
      // A test or preview copy back on mock still checks the sandbox tips it took earlier.
      return config.BACHS_SANDBOX_API_KEY
        ? createBachsProvider({
            apiKey: config.BACHS_SANDBOX_API_KEY,
            environment: 'sandbox',
          })
        : null;
    default: {
      const unreachable: never = name;
      throw new Error(`PAYMENT_PROVIDER=${String(unreachable)} is not wired`);
    }
  }
}

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
  // Mail about a waiting request goes to who may decide it, which each action says.
  registerRealSeriousActions();
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
  // Live signals over the fail-fast client: while Redis is down a publish fails at once.
  const publishLive = createWorkerLivePublisher({
    redis: markers,
    channel: liveChannel(config.QUEUE_PREFIX),
    logger,
    counter: getMeter(SERVICE_NAME).createCounter(
      'tipme.live.signals_published',
      { description: 'Live signals published, by type and outcome' },
    ),
  });
  const queue = new Queue(JOB_QUEUE, {
    connection: markers,
    prefix: config.QUEUE_PREFIX,
  });
  const database = createDatabase(config.DATABASE_URL, {
    connectionTimeoutMillis: config.DATABASE_POOL_CONNECT_TIMEOUT_MS,
  });
  const budget = adaptPoolToServer(database, {
    role: 'worker',
    override: config.DATABASE_POOL_MAX,
    refreshMs: config.DATABASE_BUDGET_REFRESH_MS,
    counts: {
      apiProcesses: config.DATABASE_BUDGET_API_PROCESSES,
      workerProcesses: config.DATABASE_BUDGET_WORKER_PROCESSES,
      margin: config.DATABASE_BUDGET_MARGIN,
    },
    log: (level, entry) => logger[level](entry),
  });
  // Starts on the small fallback if the read fails or is slow: never refuses to start.
  await budget.ready;
  const sealing = mailSealing(Buffer.from(config.MAIL_SEAL_KEY, 'base64'));
  const takeBackRevalidate = workerRevalidator(config, {
    log: (entry) => logger.warn(entry),
  });
  const reporter = createErrorReporter({
    dsn: config.SENTRY_DSN,
    service: 'worker',
    environment:
      config.SENTRY_ENVIRONMENT ??
      (config.DEPLOYMENT_MODE === 'preview' ? 'staging' : config.NODE_ENV),
    release: config.GIT_SHA,
  });
  const analyticsEnabled = config.ANALYTICS_ENABLED;
  // Reconciliation only asks the provider; `payouts.start` is the one job that moves money. Without
  // a secret the worker can never accept webhooks. It shares the fail-fast Redis client.
  const mockProvider = createMockProvider({
    redis: markers,
    prefix: config.QUEUE_PREFIX,
  });
  // The worker never holds a webhook secret.
  const bachsProvider = workerBachsProvider(config);
  const defaultProvider = mockProvider;
  const providerFor = (name: string): BachsProvider | MockProvider => {
    if (name === 'mock') return mockProvider;
    if (name === 'bachs' && bachsProvider) return bachsProvider;
    throw new Error('Unsupported persisted payment provider');
  };
  const providerForExpiry = (name: string | null) =>
    name ? providerFor(name) : defaultProvider;
  /** Pro purchases per provider this copy can read (rows record 'mock' or 'bachs'). */
  const reconcileProEverywhere = async (now: Date) => {
    const totals = { checked: 0, paid: 0, failed: 0 };
    const providers: [string, MockProvider | BachsProvider | null][] = [
      ['mock', mockProvider],
      ['bachs', bachsProvider],
    ];
    for (const [providerName, provider] of providers) {
      if (!provider?.initializePlatformCheckout) continue;
      const result = await reconcileProPurchases(database.db, {
        provider: {
          initializePlatformCheckout: (input) =>
            provider.initializePlatformCheckout!(input),
          verifyTransaction: (reference) =>
            provider.verifyTransaction(reference),
        },
        providerName,
        now,
        sealing,
        successUrl: `${new URL(config.WEB_ORIGIN).origin}/dashboard/settings#plan`,
        cancelUrl: `${new URL(config.WEB_ORIGIN).origin}/dashboard/settings#plan`,
        minAgeMs: config.RECONCILE_MIN_AGE_MS,
      });
      totals.checked += result.checked;
      totals.paid += result.paid.length;
      totals.failed += result.failed;
      // Pro paid from the balance (plan Task 8): read back, never re-sent.
      const collected = await reconcileProCollections(database.db, {
        provider,
        providerName,
        now,
        sealing,
        minAgeMs: config.RECONCILE_MIN_AGE_MS,
      });
      totals.checked += collected.checked;
      totals.paid += collected.paid.length;
      totals.failed += collected.failed;
      // Approved Pro refunds (plan Task 9): sent once; refund.paid settles them.
      const refunds = await sendProRefunds(database.db, {
        provider,
        providerName,
        now,
      });
      totals.failed += refunds.failed;
      for (const page of [...result.paid, ...collected.paid].filter(
        (p) => p.planChanged,
      )) {
        void publishLive([
          { to: { profile: page.profileId }, type: 'profile.changed' },
        ]);
        if (page.handleLower && takeBackRevalidate)
          void takeBackRevalidate(page.handleLower);
      }
    }
    return totals;
  };
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
  // Its own job, so a slow provider in reconciliation can't hold it up. Approving checks expiry too.
  const approvalsSchedule = ensureSchedule({
    queue,
    id: APPROVALS_EXPIRE_JOB,
    every: 60_000,
    logger,
  });
  // Username take-backs: notice, reminder, deadline and the 14-day path, driven by the database.
  const takeBacksSchedule = ensureSchedule({
    queue,
    id: USERNAME_TAKE_BACKS_JOB,
    every: 60_000,
    logger,
  });
  const proExpireSchedule = ensureSchedule({
    queue,
    id: PRO_EXPIRE_JOB,
    every: 60_000,
    logger,
  });
  const proRemindersSchedule = ensureSchedule({
    queue,
    id: PRO_REMINDERS_JOB,
    every: 15 * 60_000,
    logger,
  });
  const proRenewSchedule = config.PRO_AUTO_RENEW
    ? ensureSchedule({ queue, id: PRO_RENEW_JOB, every: 15 * 60_000, logger })
    : null;
  // Test copies only (RELEASE_KIND=test): every hour, erase what crashed release checks left.
  const rehearsalSchedule =
    config.RELEASE_KIND === 'test'
      ? ensureSchedule({
          queue,
          id: REHEARSAL_SWEEP_JOB,
          every: 3_600_000,
          logger,
        })
      : null;
  // Only the provider this copy actually runs: a mock copy's sandbox reader answers old tips only.
  const payoutSetupProvider =
    bachsProvider?.name === config.PAYMENT_PROVIDER ? bachsProvider : null;
  const payoutSetupSchedule = payoutSetupProvider
    ? ensureSchedule({
        queue,
        id: PAYOUT_SETUP_JOB,
        every: PAYOUT_SETUP_INTERVAL_MS,
        logger,
      })
    : null;
  // The platform reserve is read for the same provider only. A run still going when the next one
  // fires makes it skip (see runUnlessRunning), so a slow provider never stacks up reads.
  if (payoutSetupProvider)
    warnIfNoAlertRoute(config.ALERT_WEBHOOK_URL, (entry) => logger.warn(entry));
  const reserveSchedule = payoutSetupProvider
    ? ensureSchedule({
        queue,
        id: PAYMENT_RESERVE_JOB,
        every: PAYMENT_RESERVE_INTERVAL_MS,
        logger,
      })
    : null;
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
            const unknownStarts = await expireStaleAttemptStarts(database.db, {
              olderThan: new Date(now.getTime() - config.RECONCILE_MIN_AGE_MS),
              now,
            });
            const unknownAccounts = await expireStalePaymentAccountCreations(
              database.db,
              {
                olderThan: new Date(
                  now.getTime() - config.RECONCILE_MIN_AGE_MS,
                ),
                now,
              },
            );
            const payments = await reconcileAttempts({
              db: database.db,
              provider: providerFor,
              now,
              minAgeMs: config.RECONCILE_MIN_AGE_MS,
            });
            const payoutResult = await reconcilePayouts({
              db: database.db,
              provider: providerFor,
              now,
              minAgeMs: config.RECONCILE_MIN_AGE_MS,
            });
            // Paid Pro (ADR-0015): open purchases on TipMe's own account, read back from the same
            // provider that made them. A page whose plan changed is revalidated and signalled.
            const pro = await reconcileProEverywhere(now);
            // Option B: business shares between partner accounts, each leg once and read back.
            const shares = { checked: 0, failed: 0 };
            if (config.BUSINESS_SHARES_ENABLED)
              for (const provider of [mockProvider, bachsProvider]) {
                if (!provider?.collectToPlatform || !provider.transferToAccount)
                  continue;
                const result = await runShareTransfers(database.db, {
                  provider,
                  now,
                  settleWaitMs: config.BUSINESS_SHARE_SETTLE_HOURS * 3_600_000,
                });
                shares.checked += result.checked;
                shares.failed += result.failed;
              }
            // Never-paid tips are cancelled, after the provider confirms they were not paid.
            const expiry = await expireStaleTips({
              db: database.db,
              provider: providerForExpiry,
              now,
            });
            // Then the admin inbox: open issues for what still needs a person, close cleared ones.
            const detected = await runIssueDetectors(database.db, now);
            const cleared = await autoResolveIssues(database.db, now);
            logger.info({
              event: 'reconcile.completed',
              issues_opened: detected.opened,
              issues_auto_resolved: cleared.resolved,
              unknown_starts: unknownStarts,
              unknown_account_creations: unknownAccounts,
              checked: payments.checked,
              applied: payments.applied,
              unresolved: payments.unresolved,
              errors: payments.errors,
              error_kinds: payments.errorKinds,
              payouts_checked: payoutResult.checked,
              payouts_applied: payoutResult.applied,
              payouts_errors: payoutResult.errors,
              payouts_unresolved: payoutResult.unresolved,
              expired: expiry.expired,
              expired_paid: expiry.paid,
              expire_errors: expiry.errors,
              pro_checked: pro.checked,
              pro_paid: pro.paid,
              pro_errors: pro.failed,
              shares_checked: shares.checked,
              shares_errors: shares.failed,
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
              sealing,
            });
            const { created, profileIds } = await runWeeklyReports(
              database.db,
              { sealing, isoWeek },
            );
            logger.info({
              event: 'reports.weekly.completed',
              iso_week: isoWeek,
              created,
            });
            // Each report and its notification committed on its own; ids go to Redis, not the log.
            void publishLive(
              jobSignalsFor(WEEKLY_REPORTS_JOB, 'reported', { profileIds }),
            );
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
              sealing,
            });
            logger.info({ event: 'moments.monthly.completed', created });
            // After the moments, so the month is whole: Pro pages' recaps (and their emails).
            const recaps = await runMonthlyRecaps(database.db, {
              sealing,
              month: previousMonth(now),
            });
            logger.info({
              event: 'recaps.monthly.completed',
              created: recaps.created,
            });
            processed.add(1, { outcome: 'celebrated' });
            return 'celebrated';
          }
          if (job.name === APPROVALS_EXPIRE_JOB) {
            const result = await expireRequests(database.db, {
              now: new Date(),
            });
            logger.info({ event: 'approvals.expired', ...result });
            processed.add(1, { outcome: 'approvals_swept' });
            return 'approvals_swept';
          }
          if (job.name === USERNAME_TAKE_BACKS_JOB) {
            const outcome = await handleUsernameTakeBacks({
              db: database.db,
              sealing,
              now: () => new Date(),
              revalidate: takeBackRevalidate,
              log: (entry) => logger.info({ ...entry, ...fields }),
            });
            processed.add(1, { outcome });
            return outcome;
          }
          if (job.name === PRO_EXPIRE_JOB) {
            const outcome = await handleProExpire({
              db: database.db,
              sealing,
              now: () => new Date(),
              revalidate: takeBackRevalidate,
              publishLive,
              log: (entry) => logger.info({ ...entry, ...fields }),
            });
            processed.add(1, { outcome });
            return outcome;
          }
          if (job.name === PRO_RENEW_JOB) {
            // Queued before the switch went off: nothing is charged.
            if (!config.PRO_AUTO_RENEW) return 'skipped';
            const totals = { charged: 0, retried: 0 };
            for (const [providerName, provider] of [
              ['mock', mockProvider],
              ['bachs', bachsProvider],
            ] as const) {
              if (!provider?.chargeSavedCard) continue;
              const result = await renewProAutomatically(database.db, {
                provider,
                providerName,
                now: new Date(),
                sealing,
              });
              totals.charged += result.charged;
              totals.retried += result.retried;
            }
            logger.info({ event: 'pro.renew_swept', ...totals, ...fields });
            processed.add(1, { outcome: 'renewed' });
            return 'renewed';
          }
          if (job.name === PRO_REMINDERS_JOB) {
            const outcome = await handleProReminders({
              db: database.db,
              sealing,
              autoRenewOn: config.PRO_AUTO_RENEW,
              now: () => new Date(),
              log: (entry) => logger.info({ ...entry, ...fields }),
            });
            processed.add(1, { outcome });
            return outcome;
          }
          if (job.name === REHEARSAL_SWEEP_JOB) {
            // Never on a live copy, even if the job was queued before RELEASE_KIND changed.
            if (config.RELEASE_KIND !== 'test') return 'skipped';
            const result = await sweepRehearsals(database.db, {
              sealing,
              olderThanMs: REHEARSAL_GRACE_MS,
            });
            logger.info({ event: 'rehearsals.swept', ...result });
            processed.add(1, { outcome: 'swept' });
            return 'swept';
          }
          if (job.name === ANALYTICS_DAILY_JOB) {
            const now = new Date();
            for (const date of lagosDaysBefore(now, 3))
              await rollupAnalytics(database.db, { date });
            const purged = await purgeAnalytics(database.db, {
              before: new Date(now.getTime() - ANALYTICS_RETENTION_MS),
            });
            // Page reports are kept 180 days (PR-013), purged on the same daily run.
            const reportsPurged = await purgeProfileReports(database.db, {
              now,
            });
            logger.info({
              event: 'analytics.daily.completed',
              purged,
              reportsPurged,
            });
            processed.add(1, { outcome: 'rolled_up' });
            return 'rolled_up';
          }
          if (job.name === PAYOUT_SETUP_JOB) {
            if (!payoutSetupProvider) return 'skipped';
            const swept = await runUnlessRunning(
              markers,
              {
                key: `${config.QUEUE_PREFIX}:lock:${PAYOUT_SETUP_JOB}`,
                ttlMs: PAYOUT_SETUP_LOCK_TTL_MS,
              },
              () =>
                sweepPayoutSetup(database.db, {
                  provider: payoutSetupProvider,
                  log: (entry) => logger.warn({ ...entry, ...fields }),
                }),
            );
            if (!swept.ran) {
              logger.info({ event: 'payout_setup.skipped_running', ...fields });
              processed.add(1, { outcome: 'payout_setup_skipped' });
              return 'skipped';
            }
            // The ids are for the live signals only: logs carry no profile ids.
            const { changedProfileIds, ...totals } = swept.value;
            logger.info({
              event: 'payout_setup.swept',
              ...totals,
              changed: changedProfileIds.length,
              ...fields,
            });
            void publishLive(
              jobSignalsFor(PAYOUT_SETUP_JOB, 'swept', {
                profileIds: changedProfileIds,
              }),
            );
            processed.add(1, { outcome: 'payout_setup' });
            return 'swept';
          }
          if (job.name === PAYMENT_RESERVE_JOB) {
            if (!payoutSetupProvider) return 'skipped';
            const result = await runUnlessRunning(
              markers,
              {
                key: `${config.QUEUE_PREFIX}:lock:${PAYMENT_RESERVE_JOB}`,
                ttlMs: PAYMENT_RESERVE_LOCK_TTL_MS,
              },
              () =>
                handlePaymentReserve({
                  db: database.db,
                  provider: payoutSetupProvider,
                  thresholdMinor: config.BACHS_RESERVE_ALERT_MINOR,
                  alertWebhookUrl: config.ALERT_WEBHOOK_URL,
                  log: (entry) => logger.warn({ ...entry, ...fields }),
                }),
            );
            if (!result.ran) {
              logger.info({ event: 'reserve.skipped_running', ...fields });
              processed.add(1, { outcome: 'reserve_skipped' });
              return 'skipped';
            }
            logger.info({
              event: 'reserve.checked',
              outcome: result.value,
              ...fields,
            });
            processed.add(1, { outcome: `reserve_${result.value}` });
            return result.value;
          }
          if (job.name === WITHDRAWALS_SWITCH_EVENT) {
            const outcome = await handleWithdrawalsSwitchChanged(job.data, {
              url: config.ALERT_WEBHOOK_URL,
              log: (entry) => logger.warn({ ...entry, ...fields }),
            });
            processed.add(1, { outcome: `withdrawals_switch_${outcome}` });
            return outcome;
          }
          if (job.name === WITHDRAWAL_FREEZE_OPENED_EVENT) {
            const outcome = await handleWithdrawalFreezeOpened(job.data, {
              url: config.ALERT_WEBHOOK_URL,
              log: (entry) => logger.warn({ ...entry, ...fields }),
            });
            processed.add(1, { outcome: `withdrawal_freeze_${outcome}` });
            return outcome;
          }
          if (job.name === PLATFORM_REFUSAL_EVENT) {
            const outcome = await handlePlatformRefusal(job.data, {
              url: config.ALERT_WEBHOOK_URL,
              log: (entry) => logger.warn({ ...entry, ...fields }),
            });
            processed.add(1, { outcome: `platform_refusal_${outcome}` });
            return outcome;
          }
          if (job.name === PAYOUT_START_EVENT) {
            const outcome = await handlePayoutStart(job.data, {
              db: database.db,
              provider: providerFor,
              log: (entry) => logger.warn({ ...entry, ...fields }),
            });
            logger.info({ event: 'payout.start', outcome, ...fields });
            // After startPayout's own commits; never awaited, never thrown.
            void publishLive(jobSignalsFor(job.name, outcome, job.data));
            processed.add(1, { outcome: `payout_${outcome}` });
            return outcome;
          }
          if (DOMAIN_EVENT_NAMES.has(job.name)) {
            const outcome = await handleDomainEvent(job.name, job.data, {
              db: database.db,
              logger,
              rewardBudgetPerMonthMinor:
                config.REWARD_CASH_BUDGET_MINOR_PER_MONTH,
              dedupeKey: job.id,
              analyticsEnabled,
              sealing,
              pretendPayment: config.PAYMENT_PROVIDER === 'mock',
              postStaffAlert: staffAlertPoster({
                url: config.ALERT_WEBHOOK_URL,
                log: (entry) => logger.warn({ ...entry, ...fields }),
              }),
            });
            // After the handler's own writes committed (notifications, moments). Not awaited
            // and never thrown: a lost signal is caught by the page's next refresh.
            void publishLive(jobSignalsFor(job.name, outcome, job.data));
            // A tip made at a business: its managers' and team's pages re-read (plan B9 Task 23).
            if (
              job.name === 'tip.succeeded' &&
              (outcome === 'notified' || outcome === 'duplicate')
            )
              void businessTipSignals(job.data, (ref) =>
                businessLiveAudience(database.db, ref),
              ).then(publishLive);
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
          logger.warn({
            event: 'job.failed',
            reason,
            ...databaseFailureFields(error),
            ...fields,
          });
          // Expected failures (known reasons) are not errors to chase; anything else is reported.
          if (!(error instanceof Error && knownReasons.has(error.message)))
            reporter.capture(error, {
              job: job.name,
              traceId: span.spanContext().traceId,
            });
          span.setStatus({ code: SpanStatusCode.ERROR, message: reason });
          processed.add(1, { outcome: 'failed' });
          throw jobFailure(job.name, error);
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
  const relay = startOutboxRelay({
    db: database.db,
    queue,
    logger,
    publishLive,
  });
  // Configured providers; the pretend one "delivers" to the development-only pretend inbox.
  const mailProviders = configuredMailProviders(
    config,
    pretendMailSink(database.db),
  );
  // What staff chose in ops, read at most every 5 seconds. A chosen provider whose keys were
  // removed falls back to the server default instead of failing every email.
  let activeCache: { provider: MailProviderName; at: number } | null = null;
  const activeProvider = async (): Promise<MailProviderName> => {
    if (activeCache && Date.now() - activeCache.at < 5000)
      return activeCache.provider;
    const chosen = await activeMailProvider(
      database.db,
      config.MAIL_DEFAULT_PROVIDER,
    );
    const provider = mailProviders.has(chosen)
      ? chosen
      : config.MAIL_DEFAULT_PROVIDER;
    activeCache = { provider, at: Date.now() };
    return provider;
  };
  const mailDelivery = startMailDelivery({
    deps: {
      db: database.db,
      sealing,
      providers: mailProviders,
      activeProvider: () => activeProvider(),
      overrideFor: async (userId) => {
        const override = await mailOverrideFor(database.db, userId);
        if (override && !mailProviders.has(override))
          logger.warn({
            event: 'mail.override_unavailable',
            provider: override,
          });
        return override;
      },
      sender: {
        domain: config.MAIL_FROM_DOMAIN,
        name: config.MAIL_FROM_NAME,
        ...(config.MAIL_FROM_ADDRESS
          ? { address: config.MAIL_FROM_ADDRESS }
          : {}),
      },
      ...(config.MAIL_REPLY_TO ? { replyTo: config.MAIL_REPLY_TO } : {}),
      webOrigin: config.WEB_ORIGIN,
      apiOrigin: config.API_ORIGIN,
      pretendDomains: config.MAIL_PRETEND_DOMAINS,
    },
    logger,
    publishLive,
  });

  return {
    async close() {
      await schedule.stop();
      await weeklySchedule.stop();
      await monthlySchedule.stop();
      await analyticsSchedule.stop();
      await payoutSetupSchedule?.stop();
      await reserveSchedule?.stop();
      await rehearsalSchedule?.stop();
      await approvalsSchedule.stop();
      await takeBacksSchedule.stop();
      await proExpireSchedule.stop();
      await proRemindersSchedule.stop();
      await proRenewSchedule?.stop();
      await relay.stop();
      await mailDelivery.stop();
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
      budget.stop();
      await database.close().catch(() => undefined);
    },
  };
}
