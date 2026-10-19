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
    // Only the mock provider exists until a real one is approved (D-03); live payments stay off.
    PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
    PAYMENTS_LIVE_ENABLED: z.literal('false').default('false'),
    // Anonymous analytics (PR-009). Unset: on in development and test, off in production (D-07).
    ANALYTICS_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : value === 'true',
      ),
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
      context.addIssue({ code: 'custom', path: ['PREVIEW_PASSWORD'], message: 'required for preview' });
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
