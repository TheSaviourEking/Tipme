import { parseConfig } from '@tipme/observability';
import { z } from 'zod';

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
    // Sandbox only: selectable in test and password-protected preview, never production.
    PAYMENT_PROVIDER: z.enum(['mock', 'bachs-sandbox']).default('mock'),
    PAYMENTS_LIVE_ENABLED: z.literal('false').default('false'),
    BACHS_SANDBOX_API_KEY: z
      .string()
      .regex(/^sk_sandbox_.+$/)
      .optional(),
    // Anonymous analytics (PR-009). Unset: on in development and test, off in production (D-07).
    ANALYTICS_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : value === 'true',
      ),
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
    RECONCILE_INTERVAL_MS: z.coerce.number().int().min(100).default(60_000),
    RECONCILE_MIN_AGE_MS: z.coerce.number().int().min(0).default(120_000),
    // Monthly budget for TipMe's cash rewards, in minor units (pretend money; D-05 pending).
    REWARD_CASH_BUDGET_MINOR_PER_MONTH: z.coerce
      .bigint()
      .min(0n)
      .default(25_000_000n),
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
    if (
      config.PAYMENT_PROVIDER === 'mock' &&
      config.NODE_ENV === 'production' &&
      config.DEPLOYMENT_MODE !== 'preview'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['PAYMENT_PROVIDER'],
        message: 'mock not allowed in production',
      });
    }
    if (config.PAYMENT_PROVIDER === 'bachs-sandbox') {
      if (
        config.NODE_ENV === 'production' &&
        config.DEPLOYMENT_MODE !== 'preview'
      ) {
        context.addIssue({
          code: 'custom',
          path: ['PAYMENT_PROVIDER'],
          message:
            'Bachs sandbox is allowed only in test or password-protected preview',
        });
      }
      if (!config.BACHS_SANDBOX_API_KEY) {
        context.addIssue({
          code: 'custom',
          path: ['BACHS_SANDBOX_API_KEY'],
          message: 'required for Bachs sandbox',
        });
      }
    }
    if (
      config.BACHS_SANDBOX_API_KEY &&
      config.NODE_ENV === 'production' &&
      config.DEPLOYMENT_MODE !== 'preview'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['BACHS_SANDBOX_API_KEY'],
        message: 'Bachs sandbox credentials are restricted to test or preview',
      });
    }
  });
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
