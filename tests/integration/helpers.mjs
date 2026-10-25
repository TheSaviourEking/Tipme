import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';

export const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://tipme_local:tipme_local_password@127.0.0.1:5432/tipme_local';
export const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

/** BullMQ resolved from the worker package, for tests that need to place jobs directly. */
export const bullmq = createRequire(
  new URL('../../apps/worker/package.json', import.meta.url),
)('bullmq');

/** ioredis resolved from the worker package (the root has no direct dependency on it). */
export const { Redis } = createRequire(
  new URL('../../apps/worker/package.json', import.meta.url),
)('ioredis');

/** Shared by the in-process API and the test simulator. */
export const WEBHOOK_SECRET = 'integration-webhook-secret-32-characters!';
export const STATUS_TOKEN_SECRET = 'integration-status-token-secret-32-chars';
export const AUTH_CODE_SECRET = 'integration-auth-code-secret-32-characters';
export const WEB = 'http://localhost:3000';
// 32 zero-ish bytes for tests only; production keys come from the environment (ADR-0010).
export const OPS_TOTP_KEY = Buffer.alloc(32, 7).toString('base64');

export const uniquePrefix = () => `it-${randomUUID().slice(0, 8)}`;

/**
 * Runs the API and worker in this process against local Postgres/Redis. Call startTelemetry
 * before this so HTTP, Redis and Postgres modules load instrumented.
 */
export async function startStack({
  prefix = uniquePrefix(),
  workerEnv = {},
  databaseUrl = DATABASE_URL,
  apiEnv = {},
} = {}) {
  const { createApp } = await import('../../apps/api/dist/app.factory.js');
  const { loadApiConfig } = await import('../../apps/api/dist/config.js');
  const { startJobWorker } =
    await import('../../apps/worker/dist/job-worker.js');
  const { loadWorkerConfig } = await import('../../apps/worker/dist/config.js');
  const logs = [];
  const logDestination = new Writable({
    write(chunk, _encoding, done) {
      for (const line of chunk.toString().trim().split('\n'))
        logs.push(JSON.parse(line));
      done();
    },
  });
  const common = {
    NODE_ENV: 'test',
    REDIS_URL,
    QUEUE_PREFIX: prefix,
    LOG_LEVEL: 'info',
  };
  const app = await createApp(
    loadApiConfig({
      ...common,
      DATABASE_URL: databaseUrl,
      DIAGNOSTICS_ENABLED: 'true',
      MOCK_PROVIDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
      STATUS_TOKEN_SECRET,
      AUTH_CODE_SECRET,
      WEB_REVALIDATE_SECRET: 'integration-revalidate-secret-32-characters',
      OPS_TOTP_KEY,
      ...apiEnv,
    }),
    { logDestination },
  );
  await app.listen(0, '127.0.0.1');
  const worker = await startJobWorker(
    loadWorkerConfig({
      ...common,
      DATABASE_URL: databaseUrl,
      MOCK_PROVIDER_WEBHOOK_SECRET: WEBHOOK_SECRET,
      ...workerEnv,
    }),
    { logDestination },
  );
  return {
    api: await app.getUrl(),
    prefix,
    logs,
    async stop() {
      await worker.close();
      await app.close();
    },
  };
}

export async function postProbe(api, body, headers = {}) {
  const response = await fetch(`${api}/v1/diagnostics/trace-probe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

export async function waitForState(api, jobId, wanted, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${api}/v1/diagnostics/trace-probe/${jobId}`);
    if (response.status === 200) {
      const { data: status } = await response.json();
      if (wanted.includes(status.state)) return status;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `job ${jobId} did not reach ${wanted.join('/')} in ${timeoutMs} ms`,
  );
}

/** Polls a job directly in Redis (for jobs placed by tests, whose IDs the API does not accept). */
export async function waitForJob(queue, jobId, wanted, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // State before job data, so a terminal state is never paired with a stale attempt count.
    const state = await queue.getJobState(jobId);
    const job = wanted.includes(state) ? await queue.getJob(jobId) : undefined;
    if (job) return { state, attemptsMade: job.attemptsMade };
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `job ${jobId} did not reach ${wanted.join('/')} in ${timeoutMs} ms`,
  );
}

/** Headers a browser on the web app would send with an authenticated, state-changing request. */
export const browserHeaders = (cookie, extra = {}) => ({
  origin: WEB,
  'x-tipme-csrf': '1',
  'content-type': 'application/json',
  ...(cookie ? { cookie } : {}),
  ...extra,
});

/** Signs in through the API (code read from the pretend inbox) and returns the session cookie. */
export async function signIn(api, phone) {
  const send = await fetch(`${api}/v1/auth/code`, {
    method: 'POST',
    headers: browserHeaders(),
    body: JSON.stringify({ phone }),
  });
  if (send.status !== 202)
    throw new Error(`code request failed: ${send.status}`);
  const inbox = await (await fetch(`${api}/v1/dev/inbox`)).json();
  const code = /\b(\d{6})\b/.exec(inbox.data[0].body)?.[1];
  const verify = await fetch(`${api}/v1/auth/verify`, {
    method: 'POST',
    headers: browserHeaders(),
    body: JSON.stringify({ phone, code, deviceLabel: 'Integration test' }),
  });
  if (verify.status !== 200) throw new Error(`verify failed: ${verify.status}`);
  const cookie = verify.headers
    .getSetCookie()
    .find((c) => c.startsWith('tipme_session='));
  return {
    cookie: cookie.split(';')[0],
    setCookie: cookie,
    body: await verify.json(),
  };
}

/**
 * Authenticator codes for tests: each call returns a code for a step after the last one used
 * (codes are single-use), waiting for the next 30-second step when the window is used up.
 */
export function totpClock(secret) {
  let last = -1n;
  return async function nextCode() {
    const { totpAt } = await import('../../packages/domain/dist/index.js');
    for (;;) {
      const now = Date.now();
      const current = BigInt(Math.floor(now / 30_000));
      // The server accepts the previous, current and next step. The previous one expires at the
      // next 30-second boundary, so it is used only with 5 seconds to spare: a request that
      // crossed the boundary on its way would otherwise be refused (a CI flake).
      const oldest = now % 30_000 < 25_000 ? current - 1n : current;
      const step = last + 1n > oldest ? last + 1n : oldest;
      if (step <= current + 1n) {
        last = step;
        return totpAt(secret, step);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  };
}

const cookieFrom = (response, name) =>
  response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${name}=`))
    ?.split(';')[0];

/**
 * Makes `phone` the Owner (database operation, as `pnpm ops:grant-owner` does), signs in,
 * enrols an authenticator and opens an admin grant. `cookie` carries both cookies.
 */
export async function opsSignIn(api, db, phone) {
  const { grantOwner } = await import('../../packages/database/dist/index.js');
  const { enrolmentCode } = await grantOwner(db, { phone });
  const session = await signIn(api, phone);
  const enrol = await fetch(`${api}/v1/ops/enrol`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ enrolmentCode }),
  });
  if (enrol.status !== 200) throw new Error(`enrol failed: ${enrol.status}`);
  const { secret } = (await enrol.json()).data;
  const nextCode = totpClock(secret);
  const confirm = await fetch(`${api}/v1/ops/enrol/confirm`, {
    method: 'POST',
    headers: browserHeaders(session.cookie),
    body: JSON.stringify({ code: await nextCode() }),
  });
  if (confirm.status !== 200)
    throw new Error(`confirm failed: ${confirm.status}`);
  const ops = cookieFrom(confirm, 'tipme_ops');
  return {
    cookie: `${session.cookie}; ${ops}`,
    sessionCookie: session.cookie,
    opsCookie: ops,
    secret,
    nextCode,
  };
}
