/** The full stack the e2e suite runs: web, API and worker against the disposable `tipme_test`. */
import { laneConfig, withDatabaseName, withRedisDb } from '../lane';

// E2E_LANE picks the ports, database, Redis db and queue prefix (tests/lane.ts); lane 0 is the default.
export const LANE = laneConfig();
export const E2E_DATABASE_URL = withDatabaseName(
  process.env.DATABASE_URL ??
    'postgres://tipme_local:tipme_local_password@127.0.0.1:5432/tipme_local',
  LANE.databaseName,
);
export const E2E_REDIS_URL = withRedisDb(
  process.env.REDIS_URL ?? 'redis://127.0.0.1:6379',
  LANE.redisDb,
);
// globalSetup opens the lane's database through openTestDatabase, which reads this.
process.env.TIPME_TEST_DATABASE = LANE.databaseName;
export const WEB_ORIGIN = LANE.webOrigin;
export const API_ORIGIN = LANE.apiOrigin;

/** Test-only values; the developer's .env is never loaded for e2e. */
export const stackEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: E2E_DATABASE_URL,
  REDIS_URL: E2E_REDIS_URL,
  QUEUE_PREFIX: LANE.queuePrefix,
  // Read by openTestDatabase (globalSetup, helpers) in the test process and the servers.
  TIPME_TEST_DATABASE: LANE.databaseName,
  LOG_LEVEL: 'warn',
  MOCK_PROVIDER_WEBHOOK_SECRET: 'e2e-only-mock-webhook-secret-32-characters',
};

/** Shared by the e2e API and web servers so profile changes refresh cached pages. */
export const E2E_REVALIDATE_SECRET =
  'e2e-only-revalidate-secret-32-characters!';
// Seals staff authenticator secrets in end-to-end runs only (ADR-0010).
export const E2E_OPS_TOTP_KEY = Buffer.alloc(32, 9).toString('base64');
export const E2E_MAIL_SEAL_KEY = Buffer.alloc(32, 8).toString('base64');
