/** The full stack the e2e suite runs: web, API and worker against the disposable `tipme_test`. */
const base = new URL(
  process.env.DATABASE_URL ??
    'postgres://tipme_local:tipme_local_password@127.0.0.1:5432/tipme_local',
);
base.pathname = '/tipme_test';
export const E2E_DATABASE_URL = base.toString();
export const E2E_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
export const WEB_ORIGIN = 'http://127.0.0.1:3100';
export const API_ORIGIN = 'http://127.0.0.1:4100';

/** Test-only values; the developer's .env is never loaded for e2e. */
export const stackEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: E2E_DATABASE_URL,
  REDIS_URL: E2E_REDIS_URL,
  QUEUE_PREFIX: 'e2e',
  LOG_LEVEL: 'warn',
  MOCK_PROVIDER_WEBHOOK_SECRET: 'e2e-only-mock-webhook-secret-32-characters',
};

/** Shared by the e2e API and web servers so profile changes refresh cached pages. */
export const E2E_REVALIDATE_SECRET =
  'e2e-only-revalidate-secret-32-characters!';
// Seals staff authenticator secrets in end-to-end runs only (ADR-0010).
export const E2E_OPS_TOTP_KEY = Buffer.alloc(32, 9).toString('base64');
