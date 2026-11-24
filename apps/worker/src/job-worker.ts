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
import {
  announcementMailProvider,
  configuredMailProviders,
  createMailHealth,
  isProductionMail,
  mailFailoverGroup,
  mailHealthSettings,
  redisMailHealthStore,
  type MailProviderName,
} from '@tipme/mail';
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
  checkCodeDelivery,
  mailFailoverFixed,
  MAIL_PROVIDER_LABELS,
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
  sendTipRefunds,
  sweepPayoutSetup,
  runIssueDetectors,
  lagosDaysBefore,
  purgeAnalytics,
  purgeProfileReports,
  sweepRehearsals,
  rollupAnalytics,
  registerRealSeriousActions,
  businessLiveAudience,
  featureOn,
  onFeatureSwitchReadError,
  seedFeatureSwitches,
} from '@tipme/database';
import {
  bachsEnvironment,
  configuredPaymentProviders,
  createBachsProvider,
  createMockProvider,
  recordedProviderName,
  type BachsProvider,
  type MockProvider,
  wiredPaymentProvider,
} from '@tipme/payments';
import { Redis } from 'ioredis';
import { closeWithin } from './close-within.js';
import { ensureSchedule } from './ensure-schedule.js';
import { workerErrorLogger } from './redis-error-log.js';
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
import {
  collectTransferProviders,
  handleDisputeSteps,
  handleCollectTransfers,
  handleDisputeEvidence,
} from './handlers/collect-transfers.js';
import { handleCollectReminders } from './handlers/collect-reminders.js';
import {
  collectReconReader,
  collectReserveReader,
  handleCollectRecon,
  handleCollectReserve,
} from './handlers/collect-reserve.js';
import { handleWithdrawalFreezeOpened } from './handlers/withdrawal-freeze.js';
import { handlePayoutStart } from './handlers/payout-start.js';
import { handleTraceProbe } from './handlers/trace-probe.js';
import { startMailDelivery } from './mail-delivery-loop.js';
import { mailHealthAlerter } from './handlers/mail-failover.js';
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
import {
  ANNOUNCEMENTS_TICK_MS,
  handleAnnouncements,
} from './handlers/announcements.js';
import { handleProExpire, handleProReminders } from './handlers/pro.js';
import { workerRevalidator } from './revalidate.js';
import { databaseFailureFields, jobFailure } from './job-retry.js';
import { runUnlessRunning } from './run-lock.js';
import { shareTransferKinds } from './share-transfer-kinds.js';

const RECONCILE_JOB = 'reconcile.payments';
/**
 * Option B: how long after a shared tip is paid before its share is first tried (a ruling: partner
 * question (e), the settlement delay for naira charges, is still open); then it also waits until the
 * staff member's available balance holds it. A code value, not a variable (owner, 14 Nov 2026: fewer).
 */
const BUSINESS_SHARE_SETTLE_MS = 48 * 3_600_000;
const WEEKLY_REPORTS_JOB = WEEKLY_REPORTS_JOB_NAME;
const MONTHLY_MOMENTS_JOB = 'moments.monthly';
const ANALYTICS_DAILY_JOB = 'analytics.daily';
const REHEARSAL_SWEEP_JOB = 'rehearsals.sweep';
const APPROVALS_EXPIRE_JOB = 'approvals.expire';
const USERNAME_TAKE_BACKS_JOB = 'usernames.take-backs';
// Staff announcements (14 Nov 2026): the next batch, at the configured rate.
const ANNOUNCEMENTS_JOB = 'announcements.send';
// Paid Pro (ADR-0015): months move on every minute; reminders every 15 minutes.
const PRO_EXPIRE_JOB = 'pro.expire';
const PRO_REMINDERS_JOB = 'pro.reminders';
// Auto-renew (plan Task 10): a day before a month ends, every 15 minutes; it charges only while the
// `pro_auto_renew` switch is on.
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
// You collect (plan Task 8): held shares move to recipients' accounts. Every 2 minutes, always
// scheduled (with no rows it asks the partner nothing). A run still going when the next fires makes
// it skip; the lock frees itself before the following one if the process dies mid-run. Overlap
// would be safe anyway: every move is conditional, so only the partner calls are saved.
// You collect (plan Task 11, spec §7): the daily reconciliation, 02:00 in Lagos. It reads every
// recently active recipient's transfers, so it may take minutes; a run still going makes the next
// skip, and the lock frees itself well before the following day if the process dies mid-run.
const COLLECT_RECON_JOB = 'collect.recon';
const COLLECT_RECON_LOCK_TTL_MS = 60 * 60_000;
const COLLECT_TRANSFERS_JOB = 'collect.transfers';
const COLLECT_TRANSFERS_INTERVAL_MS = 2 * 60_000;
const COLLECT_TRANSFERS_LOCK_TTL_MS = 110_000;
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
 * The worker's Bachs reader: that environment's key only, and no webhook secret, so it can ask for
 * statuses but never accept a webhook. The active Bachs, else a withdraw-only one (config keeps
 * sandbox and live apart, so at most one exists per copy), else on a mock copy the sandbox reader
 * for tips it took earlier (P11). Fails startup for a provider this build cannot run (never a
 * silent mock).
 */
export function workerBachsProvider(
  config: Pick<
    WorkerConfig,
    'PAYMENT_PROVIDER' | 'BACHS_SANDBOX_API_KEY' | 'BACHS_LIVE_API_KEY'
  > &
    Partial<Pick<WorkerConfig, 'PAYMENT_WITHDRAW_ONLY_PROVIDERS'>>,
): BachsProvider | null {
  const bachsFor = (environment: 'sandbox' | 'live'): BachsProvider => {
    const apiKey =
      environment === 'live'
        ? config.BACHS_LIVE_API_KEY
        : config.BACHS_SANDBOX_API_KEY;
    if (!apiKey)
      throw new Error(
        environment === 'live'
          ? 'BACHS_LIVE_API_KEY is required for Bachs live'
          : 'BACHS_SANDBOX_API_KEY is required for Bachs sandbox',
      );
    return createBachsProvider({ apiKey, environment });
  };
  const name = wiredPaymentProvider(config.PAYMENT_PROVIDER);
  switch (name) {
    case 'bachs-live':
      return bachsFor('live');
    case 'bachs-sandbox':
      return bachsFor('sandbox');
    case 'mock': {
      const withdrawOnly = (config.PAYMENT_WITHDRAW_ONLY_PROVIDERS ?? [])
        .map((n) => bachsEnvironment(n))
        .find((environment) => environment !== null);
      if (withdrawOnly) return bachsFor(withdrawOnly);
      // A test or preview copy back on mock still checks the sandbox tips it took earlier.
      return config.BACHS_SANDBOX_API_KEY ? bachsFor('sandbox') : null;
    }
    default: {
      const unreachable: never = name;
      throw new Error(`PAYMENT_PROVIDER=${String(unreachable)} is not wired`);
    }
  }
}

export type WorkerPaymentAdapter = MockProvider | BachsProvider;

/**
 * Every payment adapter the worker holds, by the name rows record ('mock', 'mock_alt', 'bachs'),
 * and the configured withdrawal roles (configured names, e.g. 'bachs-sandbox').
 */
export interface WorkerPaymentProviders {
  byRecordedName: Map<string, WorkerPaymentAdapter>;
  withdrawalRoles: { active: string; withdrawOnly: string[] };
}

/**
 * One adapter per provider in either role, as the API builds them (PAYOUT_PROVIDERS_TOKEN), plus
 * the legacy readers (P11): mock always, and the sandbox reader on a mock copy with sandbox keys.
 * mock_alt shares the worker's Redis and QUEUE_PREFIX, as in the API. A role with no adapter stops
 * startup.
 */
export function workerPaymentProviders(
  config: Pick<
    WorkerConfig,
    | 'PAYMENT_PROVIDER'
    | 'BACHS_SANDBOX_API_KEY'
    | 'BACHS_LIVE_API_KEY'
    | 'QUEUE_PREFIX'
  > &
    Partial<Pick<WorkerConfig, 'PAYMENT_WITHDRAW_ONLY_PROVIDERS'>>,
  redis: Redis,
): WorkerPaymentProviders {
  const { active, withdrawOnly } = configuredPaymentProviders({
    PAYMENT_PROVIDER: config.PAYMENT_PROVIDER,
    PAYMENT_WITHDRAW_ONLY_PROVIDERS:
      config.PAYMENT_WITHDRAW_ONLY_PROVIDERS ?? [],
  });
  const byRecordedName = new Map<string, WorkerPaymentAdapter>();
  // Reconciliation only asks the provider; `payouts.start` is the one job that moves money. Without
  // a secret the worker can never accept webhooks.
  byRecordedName.set(
    'mock',
    createMockProvider({ redis, prefix: config.QUEUE_PREFIX }),
  );
  if (withdrawOnly.includes('mock_alt'))
    byRecordedName.set(
      'mock_alt',
      createMockProvider({
        redis,
        prefix: config.QUEUE_PREFIX,
        name: 'mock_alt',
      }),
    );
  const bachs = workerBachsProvider(config);
  if (bachs) byRecordedName.set(recordedProviderName(bachs.name), bachs);
  for (const name of [active, ...withdrawOnly]) {
    const adapter = byRecordedName.get(recordedProviderName(name));
    if (!adapter || (bachsEnvironment(name) && adapter.name !== name))
      throw new Error(`${name} is configured but has no matching adapter`);
  }
  return {
    byRecordedName,
    withdrawalRoles: { active, withdrawOnly: [...withdrawOnly] },
  };
}

/**
 * The adapter for a recorded provider name. Anything else throws, so a row at a provider this copy
 * no longer holds is never started or read through another one.
 */
export function workerProviderFor(
  providers: Pick<WorkerPaymentProviders, 'byRecordedName'>,
): (name: string) => WorkerPaymentAdapter {
  return (name) => {
    const adapter = providers.byRecordedName.get(name);
    if (!adapter) throw new Error('Unsupported persisted payment provider');
    return adapter;
  };
}

/** One platform reserve check: which schedule runs it, and for which adapter. */
export interface ReserveCheck {
  id: string;
  provider: WorkerPaymentAdapter;
  /** The active provider's: only it also checks TipMe's own money (collect reserve). */
  active: boolean;
}

/**
 * A reserve check for every connected-account adapter in either role: `payments.reserve` for the
 * active one, `payments.reserve.<recordedName>.<environment>` otherwise. A legacy reader that is in
 * no role (P11) gets none: it answers old tips only.
 */
export function reserveChecks(
  providers: WorkerPaymentProviders,
): ReserveCheck[] {
  const { active, withdrawOnly } = providers.withdrawalRoles;
  return [active, ...withdrawOnly].flatMap((name) => {
    const recorded = recordedProviderName(name);
    const adapter = providers.byRecordedName.get(recorded);
    if (adapter?.capabilities?.connectedAccounts !== true) return [];
    const isActive = name === active;
    return [
      {
        id: isActive
          ? PAYMENT_RESERVE_JOB
          : `${PAYMENT_RESERVE_JOB}.${recorded}.${adapter.environment}`,
        provider: adapter,
        active: isActive,
      },
    ];
  });
}

/** One schedule per reserve check, every 15 minutes, each with SCHEDULED_RUN_RETENTION. */
export function ensureReserveSchedules(
  deps: Pick<Parameters<typeof ensureSchedule>[0], 'queue' | 'logger'>,
  checks: readonly ReserveCheck[],
): ReturnType<typeof ensureSchedule>[] {
  return checks.map((check) =>
    ensureSchedule({
      ...deps,
      id: check.id,
      every: PAYMENT_RESERVE_INTERVAL_MS,
    }),
  );
}

/**
 * The providers whose parked payout events reconciliation rechecks: the connected-account ones held
 * here. Their webhooks park events in the shape the sweep reads; the pretend providers' unmatched
 * events go to staff instead (unmatched_event).
 */
export function parkedPayoutProviders(
  providers: Pick<WorkerPaymentProviders, 'byRecordedName'>,
): string[] {
  return [...providers.byRecordedName]
    .filter(([, adapter]) => adapter.capabilities?.connectedAccounts === true)
    .map(([name]) => name);
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
  // Feature switches (owner, 14 Nov 2026): set in admin. Any switch without a row is written from
  // the old variable, as the API does, so nothing changes on release day; a variable still set after
  // that is ignored and named.
  const stopSwitchErrors = onFeatureSwitchReadError((error) =>
    logger.warn({
      event: 'feature_switch.read_failed',
      error: error instanceof Error ? error.name : 'unknown',
    }),
  );
  // As in the API: a failed write (the database away) never stops the start; reads fall back.
  try {
    const seeded = await seedFeatureSwitches(database.db, config.switchSeeds);
    for (const { key, source } of seeded.written)
      logger.info({ event: 'feature_switch.seeded', key, source });
    for (const name of seeded.ignored)
      logger.warn({ event: 'feature_switch.env_ignored', setting: name });
  } catch (error) {
    logger.warn({
      event: 'feature_switch.seed_failed',
      error: error instanceof Error ? error.name : 'unknown',
    });
  }
  // Every adapter in either role plus the legacy readers, on the fail-fast Redis client. The worker
  // never holds a webhook secret.
  const paymentProviders = workerPaymentProviders(config, markers);
  const mockProvider = paymentProviders.byRecordedName.get('mock')!;
  const bachsProvider =
    (paymentProviders.byRecordedName.get('bachs') as
      BachsProvider | undefined) ?? null;
  /** [recorded name, adapter] for every provider held: the loops below cover each, by its own name. */
  const providers = [...paymentProviders.byRecordedName];
  const defaultProvider = mockProvider;
  const providerFor = workerProviderFor(paymentProviders);
  const providerForExpiry = (name: string | null) =>
    name ? providerFor(name) : defaultProvider;
  const parkedProviders = parkedPayoutProviders(paymentProviders);
  /** Pro purchases per provider this copy can read, each under the name its rows record. */
  const reconcileProEverywhere = async (now: Date) => {
    const totals = { checked: 0, paid: 0, failed: 0 };
    // Staff tip refunds (owner, 14 Nov 2026): approved ones are sent once, as the recipient's
    // account; refund.paid settles them. Only the `tip_refunds` switch lets anyone ask or approve one,
    // as with Pro refunds: one already approved is still sent.
    for (const [providerName, provider] of providers) {
      if (!provider.refundAccountCharge) continue;
      const tipRefunds = await sendTipRefunds(database.db, {
        provider,
        providerName,
        now,
      });
      totals.failed += tipRefunds.failed;
    }
    for (const [providerName, provider] of providers) {
      if (!provider.initializePlatformCheckout) continue;
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
        // A business's month (Business Pro) changes no page; its signals come with Phase B.
        if (page.profileId === null) continue;
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
  const announcementsSchedule = ensureSchedule({
    queue,
    id: ANNOUNCEMENTS_JOB,
    every: ANNOUNCEMENTS_TICK_MS,
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
  // Always scheduled: the switch can change while the worker runs, and the job checks it each time.
  const proRenewSchedule = ensureSchedule({
    queue,
    id: PRO_RENEW_JOB,
    every: 15 * 60_000,
    logger,
  });
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
  // The platform reserve is read for every connected-account provider in either role, each on its
  // own schedule (`payments.reserve` for the active one). A run still going when the next one fires
  // makes it skip (see runUnlessRunning), so a slow provider never stacks up reads.
  const reserves = reserveChecks(paymentProviders);
  const reserveById = new Map(reserves.map((check) => [check.id, check]));
  if (reserves.length)
    warnIfNoAlertRoute(config.ALERT_WEBHOOK_URL, (entry) => logger.warn(entry));
  const reserveSchedules = ensureReserveSchedules({ queue, logger }, reserves);
  // The same provider as the reserve check: TipMe's own account there is what is reconciled.
  const collectReserve = payoutSetupProvider
    ? collectReserveReader(payoutSetupProvider)
    : null;
  const collectRecon = payoutSetupProvider
    ? collectReconReader(payoutSetupProvider)
    : null;
  const collectReconSchedule = collectRecon
    ? ensureSchedule({
        queue,
        id: COLLECT_RECON_JOB,
        repeat: { pattern: '0 2 * * *', tz: 'Africa/Lagos' },
        logger,
      })
    : null;
  const collectTransfersSchedule = ensureSchedule({
    queue,
    id: COLLECT_TRANSFERS_JOB,
    every: COLLECT_TRANSFERS_INTERVAL_MS,
    logger,
  });
  // mock and Bachs only, as before: collect transfers follow tips, and mock_alt never takes one (its
  // pretend account rule in collect-transfers.ts is still mock's alone).
  const collectProviders = collectTransferProviders([
    mockProvider,
    bachsProvider,
  ]);
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
              parkedProviders,
              now,
              minAgeMs: config.RECONCILE_MIN_AGE_MS,
            });
            // Paid Pro (ADR-0015): open purchases on TipMe's own account, read back from the same
            // provider that made them. A page whose plan changed is revalidated and signalled.
            const pro = await reconcileProEverywhere(now);
            // Option B: business shares between partner accounts, each leg once and read back.
            // Shares move with the `business` and `business_shares` switches (admin); a chargeback's
            // fee return always moves (owner, 14 Nov 2026: TipMe always bears its fee), and so does
            // You collect's business money (final review I2: shareTransferKinds).
            const shares = { checked: 0, failed: 0 };
            const [businessOn, sharesSwitchOn] = await Promise.all([
              featureOn(database.db, 'business'),
              featureOn(database.db, 'business_shares'),
            ]);
            const kinds = shareTransferKinds({
              sharesOn: businessOn && sharesSwitchOn,
            });
            for (const [, provider] of providers) {
              if (!provider.collectToPlatform || !provider.transferToAccount)
                continue;
              const result = await runShareTransfers(database.db, {
                provider,
                now,
                settleWaitMs: BUSINESS_SHARE_SETTLE_MS,
                ...(kinds ? { kinds } : {}),
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
          if (job.name === ANNOUNCEMENTS_JOB) {
            const outcome = await handleAnnouncements({
              db: database.db,
              sealing,
              sendsPerMinute: config.ANNOUNCEMENT_SENDS_PER_MINUTE,
              now: () => new Date(),
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
            // Switched off (or queued before it went off): nothing is charged.
            if (!(await featureOn(database.db, 'pro_auto_renew')))
              return 'skipped';
            const totals = { charged: 0, retried: 0 };
            for (const [providerName, provider] of providers) {
              if (!provider.chargeSavedCard) continue;
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
              autoRenewOn: await featureOn(database.db, 'pro_auto_renew'),
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
          if (
            job.name === PAYMENT_RESERVE_JOB ||
            job.name.startsWith(`${PAYMENT_RESERVE_JOB}.`)
          ) {
            // A schedule left from an earlier configuration reads nothing.
            const check = reserveById.get(job.name);
            if (!check) return 'skipped';
            const result = await runUnlessRunning(
              markers,
              {
                key: `${config.QUEUE_PREFIX}:lock:${check.id}`,
                ttlMs: PAYMENT_RESERVE_LOCK_TTL_MS,
              },
              async () => {
                const outcome = await handlePaymentReserve({
                  db: database.db,
                  provider: check.provider,
                  thresholdMinor: config.BACHS_RESERVE_ALERT_MINOR,
                  alertWebhookUrl: config.ALERT_WEBHOOK_URL,
                  log: (entry) => logger.warn({ ...entry, ...fields }),
                });
                // You collect (Task 11): TipMe's own money against what it holds, per currency. The
                // active provider's check only.
                if (check.active && collectReserve)
                  await handleCollectReserve({
                    db: database.db,
                    provider: collectReserve,
                    alertWebhookUrl: config.ALERT_WEBHOOK_URL,
                    sealing,
                    log: (entry) => logger.warn({ ...entry, ...fields }),
                  });
                return outcome;
              },
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
          if (job.name === COLLECT_RECON_JOB) {
            if (!collectRecon) return 'skipped';
            const result = await runUnlessRunning(
              markers,
              {
                key: `${config.QUEUE_PREFIX}:lock:${COLLECT_RECON_JOB}`,
                ttlMs: COLLECT_RECON_LOCK_TTL_MS,
              },
              () =>
                handleCollectRecon({
                  db: database.db,
                  provider: collectRecon,
                  log: (entry) => logger.info({ ...entry, ...fields }),
                }),
            );
            if (!result.ran) {
              processed.add(1, { outcome: 'collect_recon_skipped' });
              return 'skipped';
            }
            processed.add(1, { outcome: `collect_recon_${result.value}` });
            return result.value;
          }
          if (job.name === COLLECT_TRANSFERS_JOB) {
            const result = await runUnlessRunning(
              markers,
              {
                key: `${config.QUEUE_PREFIX}:lock:${COLLECT_TRANSFERS_JOB}`,
                ttlMs: COLLECT_TRANSFERS_LOCK_TTL_MS,
              },
              async () => {
                const transfers = await handleCollectTransfers({
                  db: database.db,
                  providers: collectProviders,
                  log: (entry) => logger.warn({ ...entry, ...fields }),
                });
                // Task 12: reminders to add bank details ride the same sweep and lock.
                const reminders = await handleCollectReminders({
                  db: database.db,
                  sealing,
                  log: (entry) => logger.warn({ ...entry, ...fields }),
                });
                // Task 9: disputes whose share was settled by this run move on (Review Focus 3).
                const disputes = await handleDisputeSteps({
                  db: database.db,
                  log: (entry) => logger.warn({ ...entry, ...fields }),
                });
                // Task 15: evidence staff approved is submitted, once per attempt.
                const evidence = await handleDisputeEvidence({
                  db: database.db,
                  providers: providers.map(([name, provider]) => ({
                    name,
                    provider,
                  })),
                  log: (entry) => logger.warn({ ...entry, ...fields }),
                });
                return {
                  ...transfers,
                  evidenceSubmitted: evidence.submitted,
                  reminded: reminders.reminded,
                  disputesAdvanced: disputes.advanced,
                  disputeReminders: disputes.reminded,
                };
              },
            );
            if (!result.ran) {
              logger.info({
                event: 'collect_transfers.skipped_running',
                ...fields,
              });
              processed.add(1, { outcome: 'collect_transfers_skipped' });
              return 'skipped';
            }
            logger.info({
              event: 'collect_transfers.ran',
              ...result.value,
              ...fields,
            });
            processed.add(1, { outcome: 'collect_transfers' });
            return result.value.stopped ?? 'ran';
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
              analyticsEnabled: await featureOn(database.db, 'analytics'),
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
  // Rate-limited per Redis code: a full Redis raised this ~3,000 times a second (21 Nov 2026).
  worker.on('error', workerErrorLogger({ logger }));
  const relay = startOutboxRelay({
    db: database.db,
    queue,
    logger,
    publishLive,
  });
  // Configured providers; the pretend one "delivers" to the development-only pretend inbox.
  // Announcements go through their own provider (Brevo), never the ones below (owner, 14 Nov 2026).
  const announcementProvider = announcementMailProvider(
    config,
    pretendMailSink(database.db),
  );
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
  // Automatic failover (owner, 23 Nov 2026): only with MAIL_FALLBACK_PROVIDERS set. The breaker
  // lives in Redis on the fail-fast client: while Redis is down every provider reads healthy.
  const production = isProductionMail(config);
  const failoverGroup = mailFailoverGroup(
    config.MAIL_DEFAULT_PROVIDER,
    config.MAIL_FALLBACK_PROVIDERS,
    new Set(mailProviders.keys()),
    production,
  );
  // Two providers or more: a list naming only the default (refused at start anyway) or an
  // unconfigured one never turns half of it on.
  const failoverOn = failoverGroup.length > 1;
  const healthSettings = mailHealthSettings(config);
  const mailHealth = createMailHealth({
    store: redisMailHealthStore(markers, {
      ...healthSettings,
      prefix: config.QUEUE_PREFIX,
    }),
    settings: healthSettings,
    onChange: mailHealthAlerter({
      url: config.ALERT_WEBHOOK_URL,
      labels: MAIL_PROVIDER_LABELS,
      group: failoverGroup,
      log: (entry) => logger.warn(entry),
    }),
    log: (entry) => logger.warn(entry),
  });
  // Whether staff fixed the provider in ops, read at most every 5 seconds like the active one.
  let fixedCache: { fixed: boolean; at: number } | null = null;
  const failoverFixed = async (): Promise<boolean> => {
    if (fixedCache && Date.now() - fixedCache.at < 5000)
      return fixedCache.fixed;
    const fixed = await mailFailoverFixed(database.db);
    fixedCache = { fixed, at: Date.now() };
    return fixed;
  };
  const mailDelivery = startMailDelivery({
    ...(failoverOn
      ? {
          checkCodes: async (now: Date) => {
            if (await failoverFixed()) return;
            const checks = await checkCodeDelivery(database.db, {
              health: mailHealth,
              providers: failoverGroup,
              now,
              settings: {
                unusedAfterMs: config.MAIL_CODE_UNUSED_AFTER_MS,
                windowMs: config.MAIL_CODE_WINDOW_MS,
                minSamples: config.MAIL_CODE_MIN_SAMPLES,
                unusedRatio: config.MAIL_CODE_UNUSED_RATIO,
                trialCodes: config.MAIL_CODE_TRIAL_CODES,
              },
            });
            for (const check of checks)
              if (check.outcome !== 'ok' && check.outcome !== 'skipped')
                logger.warn({ event: 'mail.code_check', ...check });
          },
        }
      : {}),
    deps: {
      ...(failoverOn
        ? {
            failover: {
              health: mailHealth,
              fallbacks: config.MAIL_FALLBACK_PROVIDERS,
              defaultProvider: config.MAIL_DEFAULT_PROVIDER,
              production,
              fixed: failoverFixed,
              resendWindowMs: config.MAIL_RESEND_WINDOW_MS,
            },
          }
        : {}),
      db: database.db,
      sealing,
      providers: mailProviders,
      announcementProvider,
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
      for (const reserveSchedule of reserveSchedules)
        await reserveSchedule.stop();
      await collectTransfersSchedule.stop();
      await collectReconSchedule?.stop();
      await rehearsalSchedule?.stop();
      await approvalsSchedule.stop();
      await takeBacksSchedule.stop();
      await announcementsSchedule.stop();
      await proExpireSchedule.stop();
      await proRemindersSchedule.stop();
      await proRenewSchedule.stop();
      stopSwitchErrors();
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
