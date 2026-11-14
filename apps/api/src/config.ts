import { isProductionCopy, parseConfig } from '@tipme/observability';
import { databaseBudgetSettingsShape } from '@tipme/contracts';
import { productionDatabaseUrlProblem } from '@tipme/database';
import { checkMailSettings, mailSettingsShape } from '@tipme/mail';
import {
  bachsEnvironment,
  checkPaymentSettings,
  liveCheckoutSettingsShape,
  paymentSettingsShape,
  paymentWebhookSettingsShape,
} from '@tipme/payments';
import { z } from 'zod';

const flag = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

export const apiConfigSchema = z
  .object({
    // Hosted preview is isolated by the password gateway; production still rejects mocks.
    DEPLOYMENT_MODE: z.enum(['production', 'preview']).default('production'),
    PREVIEW_PASSWORD: z.string().min(32).optional(),
    // Unset means production, so a forgotten NODE_ENV can never enable development-only features.
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('production'),
    // 0.0.0.0 only inside a container, where Caddy is the only published entry (PR-010).
    HOST: z
      .enum(['127.0.0.1', 'localhost', '::1', '0.0.0.0'])
      .default('127.0.0.1'),
    // What this copy is: `test` allows the full release check; unset means `live` (fail-safe).
    RELEASE_KIND: z.enum(['test', 'live']).default('live'),
    // The deployed commit, shown by /health/release.
    GIT_SHA: z
      .string()
      .regex(/^[0-9a-f]{7,40}$/)
      .optional(),
    // Bearer token for the release check's rehearsal runs (test copies only). Never logged.
    RELEASE_CHECK_TOKEN: z.string().min(32).optional(),
    // Signs CI's changelog requests (drafts, pending, releases). Unset: those routes answer 404.
    // Never logged.
    CHANGELOG_SIGNING_SECRET: z.string().min(32).optional(),
    // Preview cookie scope shared by the web and API hosts, e.g. staging.example.com.
    PREVIEW_COOKIE_DOMAIN: z
      .string()
      .regex(/^[a-z0-9.-]+$/)
      .optional(),
    PORT: z.coerce.number().int().min(1024).max(65535).default(4000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    ...databaseBudgetSettingsShape,
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
    API_METRICS_PORT: z.coerce.number().int().min(1024).max(65535).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug'])
      .default('info'),
    DIAGNOSTICS_ENABLED: flag,
    // Whether this copy keeps base backups and archived WAL. Staging switched it off (31 Oct
    // 2026): its nightly dump is the backup, and /health/backups says so to the watcher.
    POINT_IN_TIME_RECOVERY: z
      .enum(['on', 'off'])
      .default('on')
      .transform((value) => value === 'on'),
    // Namespaces BullMQ and idempotency keys; lets tests isolate their queues.
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .default('tipme'),
    // Provider, live switch and Bachs credentials: one definition with the worker.
    ...paymentSettingsShape,
    ...liveCheckoutSettingsShape,
    ...paymentWebhookSettingsShape,
    MOCK_PROVIDER_WEBHOOK_SECRET: z.string().min(32).optional(),
    // The public web app; the only CORS origin and the base of checkout return URLs.
    WEB_ORIGIN: z
      .url({ protocol: /^https?$/ })
      .default('http://localhost:3000'),
    // Derives receipt (status) tokens; never logged.
    STATUS_TOKEN_SECRET: z.string().min(32),
    // Per client IP, per minute (fixed window). Tests raise them; production keeps the defaults.
    RATE_LIMIT_QUOTES_PER_MIN: z.coerce.number().int().min(1).default(30),
    RATE_LIMIT_INTENTS_PER_MIN: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_HANDLES_PER_MIN: z.coerce.number().int().min(1).default(60),
    // Anonymous analytics events per client per minute (PR-009).
    RATE_LIMIT_ANALYTICS_PER_MIN: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_REPORTS_PER_HOUR: z.coerce.number().int().min(1).default(10),
    RATE_LIMIT_UNSUBSCRIBE_PER_MIN: z.coerce.number().int().min(1).default(600),
    RATE_LIMIT_AVATARS_PER_HOUR: z.coerce.number().int().min(1).default(20),
    RATE_LIMIT_COVER_DESIGNS_PER_HOUR: z.coerce
      .number()
      .int()
      .min(1)
      .default(60),
    // Full-size designs (print, download, the studio's big picture), per address.
    RATE_LIMIT_QR_ART_PER_HOUR: z.coerce.number().int().min(1).default(120),
    // The small pictures in the design list, per signed-in person: a visit asks for up to thirty.
    RATE_LIMIT_QR_THUMBS_PER_HOUR: z.coerce.number().int().min(1).default(600),
    RATE_LIMIT_BANK_RESOLVE_PER_HOUR: z.coerce
      .number()
      .int()
      .min(1)
      .default(30),
    RATE_LIMIT_BANK_READ_PER_MIN: z.coerce.number().int().min(1).default(30),
    // Live stream connects per address per minute, counted before the session check. Tests raise it.
    // TipMe for businesses: public location reads and search (per address, a minute), and the
    // supporter's note after paying (per address, an hour).
    RATE_LIMIT_BUSINESS_PUBLIC_PER_MIN: z.coerce
      .number()
      .int()
      .min(1)
      .default(120),
    RATE_LIMIT_BUSINESS_NOTE_PER_HOUR: z.coerce
      .number()
      .int()
      .min(1)
      .default(30),
    RATE_LIMIT_LIVE_CONNECT_PER_MIN: z.coerce.number().int().min(1).default(60),
    // How long every API copy reuses the provider's balance and fee for showing a withdrawal
    // quote. Its rate limit is shared with payouts. A withdrawal itself always asks fresh; 0 is off.
    PARTNER_QUOTE_CACHE_SECONDS: z.coerce
      .number()
      .int()
      .min(0)
      .max(300)
      .default(30),
    // OnlyFans and Fansly links (Pro only, the owner's decision of 5 Nov 2026). `off` hides them
    // from every public page and refuses new ones, deleting nothing: the lever for the payment
    // partner's answer (docs/runbooks/adult-platform-links.md). Default on.
    ADULT_PLATFORM_LINKS: z
      .enum(['on', 'off'])
      .default('on')
      .transform((value) => value === 'on'),
    // Repeat supporters (Pro additions, option (a)): "Let {name} recognise me next time" on Pro
    // pages. `off` hides the tick box, stops recording and (later) hides the recipient's list,
    // deleting nothing: the lever if the D-07 privacy review says to wait
    // (docs/runbooks/supporter-recognition.md). Default on.
    // Paid Pro (ADR-0015): whether recipients may open a Pro purchase on this copy. Off by
    // default: switched on per copy once checkout on TipMe's own account is wanted there. Live
    // money still needs bachs-live with PAYMENTS_LIVE_ENABLED and the page in LIVE_CHECKOUT_HANDLES.
    PRO_BILLING_ENABLED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
    // Paying for Pro from the TipMe balance (plan Task 8; ruling 8). Off until our payment partner
    // confirms this use (plan partner question 1). The capability is proven in the sandbox (E3).
    PRO_PAY_FROM_BALANCE: z
      .enum(['on', 'off'])
      .default('off')
      .transform((value) => value === 'on'),
    // Staff refunds of card-paid Pro months (plan Task 9; ruling 6). Off by default: switched on
    // once a refund has been proven in the sandbox (evidence E7).
    PRO_REFUNDS: z
      .enum(['on', 'off'])
      .default('off')
      .transform((value) => value === 'on'),
    // Auto-renew on a saved naira card (plan Task 10; ruling 9). Off by default, and the worker's
    // own switch must be on too: only after the sandbox proof (evidence E8 to E10).
    PRO_AUTO_RENEW: z
      .enum(['on', 'off'])
      .default('off')
      .transform((value) => value === 'on'),
    SUPPORTER_RECOGNITION: z
      .enum(['on', 'off'])
      .default('on')
      .transform((value) => value === 'on'),
    // Anonymous analytics. On unless set to false (owner's decision, 9 Nov 2026; D-07 stays open).
    ANALYTICS_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    // Sign-in code requests per client per hour (each number is also limited to 3 an hour).
    RATE_LIMIT_AUTH_PER_HOUR: z.coerce.number().int().min(1).default(10),
    // Authenticator codes re-entered per staff member per hour (the code itself locks after 5 misses).
    RATE_LIMIT_OPS_CODE_PER_HOUR: z.coerce.number().int().min(1).default(60),
    RATE_LIMIT_OPS_REQUEST_PER_HOUR: z.coerce.number().int().min(1).default(60),
    // Admin reads that are limited at all (the Usernames list and check), per staff member per hour.
    RATE_LIMIT_OPS_READ_PER_HOUR: z.coerce.number().int().min(1).default(600),
    // Sign-in codes per phone number per hour. Keep 3 on any copy people use; local drills raise it.
    RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(3),
    // A test copy's own never-deliverable domains (as the worker's): their sign-in codes only reach
    // the pretend inbox, so the per-address limit is lifted for them (release check, test sign-ups).
    MAIL_PRETEND_DOMAINS: z
      .string()
      .default('')
      .transform((value) =>
        value
          .split(',')
          .map((d) => d.trim().toLowerCase())
          .filter(Boolean),
      ),
    // Keys sign-in codes (HMAC); never logged.
    AUTH_CODE_SECRET: z.string().min(32),
    // Mail (mail platform spec §4.5). The default sends until staff choose a provider in ops.
    ...mailSettingsShape,
    // Page photos in a private Cloudflare R2 bucket (31 Oct 2026): all four, or none (Postgres).
    R2_ACCOUNT_ID: z.string().min(1).optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    R2_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/)
      .optional(),
    // Lets the API ask the web app to refresh a cached public profile.
    WEB_REVALIDATE_SECRET: z.string().min(32),
    // Defaults to `${WEB_ORIGIN}/api/revalidate`.
    WEB_REVALIDATE_URL: z.url({ protocol: /^https?$/ }).optional(),
    // Seals staff authenticator secrets (AES-256-GCM): 32 bytes, base64. Never logged (ADR-0010).
    // Seals queued email (addresses, codes, links) at rest: 32 bytes, base64. Never logged.
    MAIL_SEAL_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'must be 32 bytes, base64',
      }),
    OPS_TOTP_KEY: z
      .string()
      .refine((value) => Buffer.from(value, 'base64').length === 32, {
        message: 'must be 32 bytes, base64',
      }),
    // Link from an issue to its trace. Contains {traceId}. Development defaults to local Jaeger;
    // production shows no link unless set.
    OPS_TRACE_URL_TEMPLATE: z
      .string()
      .regex(/^https?:\/\/[^\s]+\{traceId\}[^\s]*$/)
      .optional(),
    // Error reporting (PR-011): Sentry-compatible DSN; unset = off. Never logged.
    SENTRY_DSN: z.url({ protocol: /^https?$/ }).optional(),
    SENTRY_ENVIRONMENT: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .optional(),
    // Proxies in front of the API whose X-Forwarded-For is trusted for the client IP (0: none).
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
    // Live updates (signals over text/event-stream). Off: both stream routes answer 204.
    LIVE_UPDATES_ENABLED: flag,
    // TipMe for businesses (plan 2026-11-06-business). Off: every business route answers 404 and
    // a tip intent's businessMemberId is dropped before it reaches the database.
    BUSINESS_ENABLED: flag,
    // Business release 2, each on top of BUSINESS_ENABLED and off by default. Off: the API ignores
    // a share or team-tip field and every posting is today's. The owner turns each on only after
    // its PR (R2-C2, R2-D) is on dev and the terms and privacy text is live.
    BUSINESS_SHARES_ENABLED: flag,
    TEAM_TIPS_ENABLED: flag,
    // Owner, 12 Nov 2026: TipMe returns its platform fee on every refunded tip (once refund.paid
    // is final) and on a lost dispute staff reverse, by transfer to the person's account. Unset:
    // on with the pretend provider (and e2e), off with our real partner until the owner turns it
    // on. Shared business tips get it whatever this says (option B).
    REFUND_FEE_RETURN: z.enum(['true', 'false']).optional(),

    // Open streams per API process; beyond it a connect gets 503 and the page polls.
    LIVE_MAX_STREAMS: z.coerce.number().int().min(1).default(2000),
    // The stream's heartbeat comment. Tests shorten it; production keeps 20 s.
    LIVE_HEARTBEAT_MS: z.coerce.number().int().min(1000).default(20000),
    // On SIGTERM, how long readiness answers 503 before the server closes, so the load balancer
    // (health checks every 2 s) stops routing here first. Keep above two check intervals.
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(30000).default(5000),
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
      config.DEPLOYMENT_MODE === 'preview' &&
      new URL(config.WEB_ORIGIN).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'preview requires HTTPS',
      });
    }

    if (config.NODE_ENV === 'production' && config.DIAGNOSTICS_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['DIAGNOSTICS_ENABLED'],
        message: 'not allowed in production',
      });
    }
    checkPaymentSettings(config, context, { webhooks: true });
    // Bachs (sandbox or live) sends supporters back to the web app and refuses local addresses.
    // WEB_ORIGIN defaults to localhost, so an unset one is refused here too.
    if (bachsEnvironment(config.PAYMENT_PROVIDER)) {
      const webHost = new URL(config.WEB_ORIGIN).hostname;
      if (
        ['localhost', '127.0.0.1', '[::1]', '0.0.0.0'].includes(webHost) ||
        webHost.endsWith('.localhost')
      ) {
        context.addIssue({
          code: 'custom',
          path: ['WEB_ORIGIN'],
          message:
            'Bachs needs a public web address (for example an https tunnel), not localhost',
        });
      }
    }
    if (
      isProductionCopy(config) &&
      new URL(config.WEB_ORIGIN).protocol !== 'https:'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['WEB_ORIGIN'],
        message: 'production requires HTTPS',
      });
    }
    if (config.PAYMENT_PROVIDER === 'bachs-sandbox') {
      if (!config.BACHS_WEBHOOK_SECRET) {
        context.addIssue({
          code: 'custom',
          path: ['BACHS_WEBHOOK_SECRET'],
          message: 'required for Bachs sandbox',
        });
      }
      if (!config.MOCK_PROVIDER_WEBHOOK_SECRET) {
        context.addIssue({
          code: 'custom',
          path: ['MOCK_PROVIDER_WEBHOOK_SECRET'],
          message: 'required to preserve existing mock webhook handling',
        });
      }
    }
    checkMailSettings(config, context);
    const r2 = [
      'R2_ACCOUNT_ID',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
      'R2_BUCKET',
    ] as const;
    const missingR2 = r2.filter((name) => !config[name]);
    if (missingR2.length && missingR2.length < r2.length)
      for (const name of missingR2)
        context.addIssue({
          code: 'custom',
          path: [name],
          message: 'required with the other R2 settings',
        });
    // A production copy carries none of the rehearsal settings (messages name, never show, them).
    if (isProductionCopy(config)) {
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
      if (config.RELEASE_CHECK_TOKEN)
        context.addIssue({
          code: 'custom',
          path: ['RELEASE_CHECK_TOKEN'],
          message: 'not allowed in production',
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
    if (
      config.PAYMENT_PROVIDER === 'mock' &&
      !config.MOCK_PROVIDER_WEBHOOK_SECRET
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MOCK_PROVIDER_WEBHOOK_SECRET'],
        message: 'required for the mock provider',
      });
    }
  })
  .transform((config) => ({
    ...config,
    REFUND_FEE_RETURN:
      config.REFUND_FEE_RETURN === undefined
        ? config.PAYMENT_PROVIDER === 'mock'
        : config.REFUND_FEE_RETURN === 'true',
  }));
export type ApiConfig = z.infer<typeof apiConfigSchema>;

export const API_CONFIG = Symbol('API_CONFIG');
export const SERVICE_NAME = 'tipme-api';

/** Empty strings (common in .env files) mean "not set". */
export function loadApiConfig(
  env: Record<string, string | undefined>,
): ApiConfig {
  const present = Object.fromEntries(
    Object.entries(env).filter(([, value]) => value !== ''),
  );
  return parseConfig(apiConfigSchema, present);
}
