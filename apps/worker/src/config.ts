import { isProductionCopy, parseConfig } from '@tipme/observability';
import { databaseBudgetSettingsShape } from '@tipme/contracts';
import { productionDatabaseUrlProblem } from '@tipme/database';
import { checkMailSettings, mailSettingsShape } from '@tipme/mail';
import { checkPaymentSettings, paymentSettingsShape } from '@tipme/payments';
import { z } from 'zod';

/** The pretend monthly cash reward budget outside production (D-05 pending). */
const PRETEND_REWARD_CASH_BUDGET_MINOR = 25_000_000n;

export const workerConfigSchema = z
  .object({
    // Hosted preview is isolated by the password gateway; production still rejects mocks.
    DEPLOYMENT_MODE: z.enum(['production', 'preview']).default('production'),
    PREVIEW_PASSWORD: z.string().min(32).optional(),
    // Unset means production (as in the API): development-only features fail closed.
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('production'),
    RELEASE_KIND: z.enum(['test', 'live']).default('live'),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    ...databaseBudgetSettingsShape,
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
    WORKER_METRICS_PORT: z.coerce
      .number()
      .int()
      .min(1024)
      .max(65535)
      .optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug'])
      .default('info'),
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .default('tipme'),
    // Seals queued email (addresses, codes, links) at rest: 32 bytes, base64. Never logged.
    MAIL_SEAL_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'must be 32 bytes, base64',
      }),
    // Mail (mail platform spec §4.5). The default sends until staff choose a provider in ops.
    ...mailSettingsShape,
    // Each kind of email has its own sender on this domain (security@, notifications@, …).
    MAIL_FROM_DOMAIN: z
      .string()
      .regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
      .default('mail.usetipme.xyz'),
    // Optional: one address for every email instead of security@, notifications@, … on the
    // domain above (e.g. staging@usetipme.xyz while the staging mail domain awaits verification).
    MAIL_FROM_ADDRESS: z.email().optional(),
    // The brand in each sender's name: "TipMe Security", "TipMe Notifications", …
    MAIL_FROM_NAME: z.string().min(1).max(40).default('TipMe'),
    MAIL_REPLY_TO: z.email().optional(),
    // One-click unsubscribe links in optional emails point here (the API's public address).
    API_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .default('http://localhost:4000'),
    // Test domains whose mail goes to the pretend inbox instead of the provider (comma-separated),
    // besides the reserved .example/.test/.invalid. Only where the pretend provider exists.
    MAIL_PRETEND_DOMAINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      ),
    // Links in emails point here.
    WEB_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .default('http://localhost:3000'),
    // Tells the web app a page changed username (the take-back sweep), as the API does. Optional:
    // unset, cached pages refresh within 5 minutes on their own.
    WEB_REVALIDATE_URL: z.url({ protocol: /^https?$/ }).optional(),
    WEB_REVALIDATE_SECRET: z.string().min(32).optional(),
    // Provider, live switch and Bachs API keys: one definition with the API (no webhook secrets).
    ...paymentSettingsShape,
    // Anonymous analytics. On unless set to false (owner's decision, 9 Nov 2026; D-07 stays open).
    ANALYTICS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    // Auto-renew on a saved naira card (plan Task 10; ruling 9): the `pro.renew` sweep charges only
    // with this on. Off by default, until the sandbox proof (evidence E8 to E10).
    PRO_AUTO_RENEW: z
      .enum(['on', 'off'])
      .default('off')
      .transform((value) => value === 'on'),
    // Business release 2, option B: move each shared tip's money staff -> TipMe -> business once
    // it is available, and put refunds right. Off by default; on with the API's flag of the same
    // name (both BUSINESS_ENABLED and it on there), never alone.
    BUSINESS_SHARES_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    // How long after a shared tip is paid before its share is first tried (a ruling: partner
    // question (e), the settlement delay for naira charges, is still open). Then it also waits
    // until the staff member's available balance holds it.
    BUSINESS_SHARE_SETTLE_HOURS: z.coerce.number().min(0).max(240).default(48),
    // Owner, 12 Nov 2026: TipMe returns its platform fee on every refunded tip (once refund.paid
    // is final) and on a lost dispute staff reverse, by transfer to the person's account. Unset:
    // on with the pretend provider (and e2e), off with our real partner until the owner turns it
    // on. The worker sends what the API asked for while this is on.
    REFUND_FEE_RETURN: z.enum(['true', 'false']).optional(),

    // Error reporting (PR-011): Sentry-compatible DSN; unset = off. Never logged.
    SENTRY_DSN: z.url({ protocol: /^https?$/ }).optional(),
    SENTRY_ENVIRONMENT: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .optional(),
    GIT_SHA: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
    // The payment reserve is "low" below this many kobo (default 100000 = ₦1,000). Positive: 0
    // would silently switch the low alert off.
    BACHS_RESERVE_ALERT_MINOR: z
      .string()
      .regex(/^[1-9][0-9]{0,14}$/)
      .default('100000')
      .transform((value) => BigInt(value)),
    // Where reserve alerts go: a Slack-compatible incoming webhook. Optional, but production with
    // live payments on refuses to start without it (below); it must be https in production. It is
    // a secret (the address is the credential), so it is never logged or put in a message.
    ALERT_WEBHOOK_URL: z.url({ protocol: /^https?$/ }).optional(),
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(100).default(60_000),
    RECONCILE_MIN_AGE_MS: z.coerce.number().int().min(0).default(120_000),
    // Monthly budget for TipMe's cash rewards, in minor units (pretend money; D-05 pending).
    // Unset resolves below: 0 on a production copy, the pretend default everywhere else.
    REWARD_CASH_BUDGET_MINOR_PER_MONTH: z.coerce.bigint().min(0n).optional(),
    /** Test-only: simulated work so shutdown draining can be observed. */
    TRACE_PROBE_TEST_DELAY_MS: z.coerce
      .number()
      .int()
      .min(0)
      .max(4000)
      .optional(),
  })
  .superRefine((config, context) => {
    if (config.DEPLOYMENT_MODE === 'preview' && !config.PREVIEW_PASSWORD) {
      context.addIssue({
        code: 'custom',
        path: ['PREVIEW_PASSWORD'],
        message: 'required for preview',
      });
    }

    if (
      config.TRACE_PROBE_TEST_DELAY_MS !== undefined &&
      config.NODE_ENV !== 'test'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['TRACE_PROBE_TEST_DELAY_MS'],
        message: 'test only',
      });
    }
    checkMailSettings(config, context);
    if (
      config.NODE_ENV === 'production' &&
      config.ALERT_WEBHOOK_URL &&
      !config.ALERT_WEBHOOK_URL.startsWith('https://')
    )
      context.addIssue({
        code: 'custom',
        path: ['ALERT_WEBHOOK_URL'],
        message: 'must be https in production',
      });
    // Once live payments are on, a reserve alert nobody receives is not acceptable. While they are
    // off (the site starts closed) the worker only warns at startup.
    if (
      isProductionCopy(config) &&
      config.PAYMENT_PROVIDER === 'bachs-live' &&
      config.PAYMENTS_LIVE_ENABLED &&
      !config.ALERT_WEBHOOK_URL
    )
      context.addIssue({
        code: 'custom',
        path: ['ALERT_WEBHOOK_URL'],
        message: 'required once live payments are on',
      });
    // A production copy carries none of the rehearsal settings (messages name, never show, them).
    if (isProductionCopy(config)) {
      // Reward cash posts to real recipients' balances, so it stays 0 until D-05 decides it.
      if ((config.REWARD_CASH_BUDGET_MINOR_PER_MONTH ?? 0n) !== 0n)
        context.addIssue({
          code: 'custom',
          path: ['REWARD_CASH_BUDGET_MINOR_PER_MONTH'],
          message: 'must be 0 in production until D-05 decides cash rewards',
        });
      if (config.PREVIEW_PASSWORD)
        context.addIssue({
          code: 'custom',
          path: ['PREVIEW_PASSWORD'],
          message: 'not allowed in production',
        });
      if (config.MAIL_PRETEND_DOMAINS.length)
        context.addIssue({
          code: 'custom',
          path: ['MAIL_PRETEND_DOMAINS'],
          message: 'not allowed in production',
        });
      if (config.RELEASE_KIND === 'test')
        context.addIssue({
          code: 'custom',
          path: ['RELEASE_KIND'],
          message: 'a production copy is never a test copy',
        });
    }
    if (
      config.NODE_ENV === 'production' &&
      config.DEPLOYMENT_MODE !== 'preview'
    ) {
      const problem = productionDatabaseUrlProblem(config.DATABASE_URL);
      if (problem)
        context.addIssue({
          code: 'custom',
          path: ['DATABASE_URL'],
          message: problem,
        });
    }
    checkPaymentSettings(config, context, { webhooks: false });
  })
  .transform((config) => ({
    ...config,
    REWARD_CASH_BUDGET_MINOR_PER_MONTH:
      config.REWARD_CASH_BUDGET_MINOR_PER_MONTH ??
      (isProductionCopy(config) ? 0n : PRETEND_REWARD_CASH_BUDGET_MINOR),
    REFUND_FEE_RETURN:
      config.REFUND_FEE_RETURN === undefined
        ? config.PAYMENT_PROVIDER === 'mock'
        : config.REFUND_FEE_RETURN === 'true',
  }));
export type WorkerConfig = z.infer<typeof workerConfigSchema>;

export const SERVICE_NAME = 'tipme-worker';

/** Empty strings (common in .env files) mean "not set". */
export function loadWorkerConfig(
  env: Record<string, string | undefined>,
): WorkerConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== ''),
  );
  return parseConfig(workerConfigSchema, present);
}
