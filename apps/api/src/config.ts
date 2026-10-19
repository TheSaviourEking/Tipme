import { parseConfig } from '@tipme/observability';
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
    HOST: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1024).max(65535).default(4000),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    OTEL_EXPORTER_OTLP_ENDPOINT: z.url({ protocol: /^https?$/ }).optional(),
    OTEL_TRACES_SAMPLER_RATIO: z.coerce.number().min(0).max(1).default(1),
    API_METRICS_PORT: z.coerce.number().int().min(1024).max(65535).optional(),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug'])
      .default('info'),
    DIAGNOSTICS_ENABLED: flag,
    // Namespaces BullMQ and idempotency keys; lets tests isolate their queues.
    QUEUE_PREFIX: z
      .string()
      .regex(/^[a-z0-9-]{1,32}$/)
      .default('tipme'),
    // Only the mock exists until a real provider is approved (D-03); live payments stay off.
    PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
    PAYMENTS_LIVE_ENABLED: z.literal('false').default('false'),
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
    // Anonymous analytics collection. Unset: on in development and test, off in production until
    // the privacy decision (D-07) is made.
    ANALYTICS_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .transform((value) =>
        value === undefined ? undefined : value === 'true',
      ),
    // Sign-in code requests per client per hour (each number is also limited to 3 an hour).
    RATE_LIMIT_AUTH_PER_HOUR: z.coerce.number().int().min(1).default(10),
    // Keys sign-in codes (HMAC); never logged.
    AUTH_CODE_SECRET: z.string().min(32),
    // Only the pretend messenger exists until a messaging provider is approved (D-08).
    MESSAGING_PROVIDER: z.enum(['mock']).default('mock'),
    // Lets the API ask the web app to refresh a cached public profile.
    WEB_REVALIDATE_SECRET: z.string().min(32),
    // Defaults to `${WEB_ORIGIN}/api/revalidate`.
    WEB_REVALIDATE_URL: z.url({ protocol: /^https?$/ }).optional(),
    // Seals staff authenticator secrets (AES-256-GCM): 32 bytes, base64. Never logged (ADR-0010).
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
    // Proxies in front of the API whose X-Forwarded-For is trusted for the client IP (0: none).
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  })
  .superRefine((config, context) => {
    if (config.DEPLOYMENT_MODE === 'preview' && !config.PREVIEW_PASSWORD) {
      context.addIssue({ code: 'custom', path: ['PREVIEW_PASSWORD'], message: 'required for preview' });
    }
    if (config.DEPLOYMENT_MODE === 'preview' && new URL(config.WEB_ORIGIN).protocol !== 'https:') {
      context.addIssue({ code: 'custom', path: ['WEB_ORIGIN'], message: 'preview requires HTTPS' });
    }

    if (config.NODE_ENV === 'production' && config.DIAGNOSTICS_ENABLED) {
      context.addIssue({
        code: 'custom',
        path: ['DIAGNOSTICS_ENABLED'],
        message: 'not allowed in production',
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
    if (
      config.MESSAGING_PROVIDER === 'mock' &&
      config.NODE_ENV === 'production' &&
      config.DEPLOYMENT_MODE !== 'preview'
    ) {
      context.addIssue({
        code: 'custom',
        path: ['MESSAGING_PROVIDER'],
        message: 'mock not allowed in production',
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
  });
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
