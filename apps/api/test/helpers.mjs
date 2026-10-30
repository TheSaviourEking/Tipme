import { Writable } from 'node:stream';
import { loadApiConfig } from '../dist/config.js';
import { createApp } from '../dist/app.factory.js';

/** Valid config whose Postgres/Redis point at closed ports, so unit tests need no infrastructure. */
export function testConfig(overrides = {}) {
  return loadApiConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://tipme:tipme@127.0.0.1:1/tipme',
    REDIS_URL: 'redis://127.0.0.1:1',
    LOG_LEVEL: 'info',
    MOCK_PROVIDER_WEBHOOK_SECRET: 'unit-test-webhook-secret-32-characters',
    STATUS_TOKEN_SECRET: 'unit-test-status-token-secret-32-chars',
    AUTH_CODE_SECRET: 'unit-test-auth-code-secret-32-characters',
    WEB_REVALIDATE_SECRET: 'unit-test-revalidate-secret-32-characters',
    OPS_TOTP_KEY: Buffer.alloc(32, 3).toString('base64'),
    MAIL_SEAL_KEY: Buffer.alloc(32, 4).toString('base64'),
    ...overrides,
  });
}

export async function startApp(t, overrides = {}) {
  const logs = [];
  const logDestination = new Writable({
    write(chunk, _encoding, done) {
      for (const line of chunk.toString().trim().split('\n'))
        logs.push(JSON.parse(line));
      done();
    },
  });
  const app = await createApp(testConfig(overrides), { logDestination });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  return { app, origin: await app.getUrl(), logs };
}
