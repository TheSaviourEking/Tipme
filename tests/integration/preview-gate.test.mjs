import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startTelemetry } from '../../packages/observability/dist/index.js';
import { InMemorySpanExporter } from '../../packages/observability/dist/testing.js';
import { openTestDatabase } from '../../packages/database/dist/test-support.js';
import { seedDemoProfiles } from '../../packages/database/dist/index.js';
import {
  issuePreviewTicket,
  previewServerKey,
} from '../../packages/domain/dist/index.js';
import { startStack } from './helpers.mjs';

startTelemetry({
  serviceName: 'tipme-integration',
  sampleRatio: 1,
  spanExporter: new InMemorySpanExporter(),
});

const PASSWORD = 'staging-preview-password-for-tests-only!';
const RELEASE_TOKEN = 'release-check-token-for-tests-only-0123456789';
const WEB = 'https://staging.example.test';
let database;
let gated;
let open;
before(async () => {
  database = await openTestDatabase();
  await database.reset();
  await seedDemoProfiles(database.db);
  gated = await startStack({
    databaseUrl: database.url,
    apiEnv: {
      WEB_ORIGIN: WEB,
      DEPLOYMENT_MODE: 'preview',
      PREVIEW_PASSWORD: PASSWORD,
      PREVIEW_COOKIE_DOMAIN: 'staging.example.test',
      RELEASE_KIND: 'test',
      RELEASE_CHECK_TOKEN: RELEASE_TOKEN,
      GIT_SHA: 'abc1234',
    },
  });
  open = await startStack({ databaseUrl: database.url });
});
after(async () => {
  await gated.stop();
  await open.stop();
  await database.close();
});

const ticket = () => `__Secure-tipme_preview=${issuePreviewTicket(PASSWORD)}`;
const get = (api, path, headers = {}) => fetch(`${api}${path}`, { headers });

test('without the preview cookie every app route is refused, including the pretend inbox (Review Focus 1)', async () => {
  for (const path of [
    '/v1/profiles/tobi',
    '/v1/dev/inbox',
    '/v1/ops/me',
    '//v1/dev/inbox',
    '/v1/%2e%2e/v1/dev/inbox',
  ]) {
    const response = await get(gated.api, path);
    assert.equal(response.status, 401, path);
    assert.equal((await response.json()).error.code, 'PREVIEW_REQUIRED');
  }
});

test('behind the preview password, the pretend inbox still needs the release token', async () => {
  // The preview password is shared with every tester; it must not also hand out sign-in codes.
  for (const authorization of [undefined, 'Bearer nope', RELEASE_TOKEN])
    assert.equal(
      (
        await get(gated.api, '/v1/dev/inbox', {
          cookie: ticket(),
          ...(authorization ? { authorization } : {}),
        })
      ).status,
      404,
      String(authorization),
    );
  const allowed = await get(gated.api, '/v1/dev/inbox', {
    cookie: ticket(),
    authorization: `Bearer ${RELEASE_TOKEN}`,
  });
  assert.equal(allowed.status, 200);
  assert.ok(Array.isArray((await allowed.json()).data));
  // Outside preview (local development and tests) it needs nothing.
  assert.equal((await get(open.api, '/v1/dev/inbox')).status, 200);
});

test('a valid ticket or the server key passes; a forged or expired ticket does not', async () => {
  assert.equal(
    (await get(gated.api, '/v1/profiles/tobi', { cookie: ticket() })).status,
    200,
  );
  assert.equal(
    (
      await get(gated.api, '/v1/profiles/tobi', {
        'x-tipme-preview-key': previewServerKey(PASSWORD),
      })
    ).status,
    200,
  );
  const expired = issuePreviewTicket(PASSWORD, Date.now() - 13 * 3600_000);
  for (const cookie of [
    `__Secure-tipme_preview=${expired}`,
    `__Secure-tipme_preview=${issuePreviewTicket('another-password-of-forty-characters!!')}`,
    `tipme_preview=${issuePreviewTicket(PASSWORD)}`,
  ])
    assert.equal(
      (await get(gated.api, '/v1/profiles/tobi', { cookie })).status,
      401,
      cookie,
    );
  assert.equal(
    (
      await get(gated.api, '/v1/profiles/tobi', {
        'x-tipme-preview-key': 'nope',
      })
    ).status,
    401,
  );
});

test('health, release info and signed webhooks need no cookie', async () => {
  assert.equal((await get(gated.api, '/health/ready')).status, 200);
  const info = await get(gated.api, '/health/release');
  assert.equal(info.status, 200);
  assert.deepEqual((await info.json()).data, {
    kind: 'test',
    version: 'abc1234',
    deploymentMode: 'preview',
    paymentsLive: false,
    analytics: true,
    paymentProvider: 'mock',
  });
  // Unsigned, so refused by the webhook itself (400/401), not by the gate.
  const hook = await fetch(`${gated.api}/v1/webhooks/mock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  assert.notEqual((await hook.json()).error?.code, 'PREVIEW_REQUIRED');
});

test('in preview, browser calls to every API path are credentialed from the web origin', async () => {
  const preflight = await fetch(`${gated.api}/v1/tip-quotes`, {
    method: 'OPTIONS',
    headers: {
      origin: WEB,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), WEB);
  assert.equal(
    preflight.headers.get('access-control-allow-credentials'),
    'true',
  );
  // The receipt page sends its status token as a bearer header (final fix: it was refused).
  const status = await fetch(`${gated.api}/v1/tips/x`, {
    method: 'OPTIONS',
    headers: {
      origin: WEB,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization',
    },
  });
  assert.match(
    status.headers.get('access-control-allow-headers') ?? '',
    /authorization/,
  );
});

test('outside preview there is no gate and release info says live by default', async () => {
  assert.equal((await get(open.api, '/v1/profiles/tobi')).status, 200);
  const info = (await (await get(open.api, '/health/release')).json()).data;
  assert.equal(info.kind, 'live');
  assert.equal(info.deploymentMode, 'production');
  assert.equal(info.paymentsLive, false);
});
