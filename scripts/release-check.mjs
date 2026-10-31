#!/usr/bin/env node
// The release check (PR-010): `pnpm release:check --web <url> --api <url> [--full]`.
//
// Read-only by default: safe on any copy (including one taking real payments), it creates
// nothing. `--full` plays the whole story
// (tip → dashboard → withdrawal → admin issue) as a tagged rehearsal and cleans up after itself,
// and only on a copy that declares RELEASE_KIND=test. Secrets come from the environment, never
// the command line: RELEASE_PREVIEW_PASSWORD, RELEASE_CHECK_TOKEN, RELEASE_OPS_EMAIL,
// RELEASE_OPS_TOTP_SECRET. On the Bachs sandbox a new page cannot take tips until its owner
// completes Bachs' own form, so tips go to a standing test page set up once by hand: @release_bachs,
// or RELEASE_BACHS_HANDLE (docs/runbooks/staging-setup.md).
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    web: { type: 'string' },
    api: { type: 'string' },
    full: { type: 'boolean', default: false },
    handle: { type: 'string' },
    'expect-version': { type: 'string' },
    // Fails the check when the copy reports another payment provider (production: bachs-live).
    'expect-provider': { type: 'string' },
    // Local copies only: accept a self-signed certificate.
    insecure: { type: 'boolean', default: false },
  },
});

function stop(message, code = 2) {
  console.error(`Release check: ${message}`);
  process.exit(code);
}

const https = (value, name) => {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
    return url.origin;
  } catch {
    return stop(`--${name} must be an http(s) address`);
  }
};
if (!values.web || !values.api)
  stop('usage: pnpm release:check --web <url> --api <url> [--full]');
const web = https(values.web, 'web');
const api = https(values.api, 'api');
if (values.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

// What the copy says it is decides what may run: a full check never touches a live copy.
let info;
try {
  const response = await fetch(`${api}/health/release`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  info = (await response.json()).data;
} catch (error) {
  stop(`could not read ${api}/health/release (${error.message})`);
}
console.log(
  `Release check against ${web} (API ${api}): version ${info.version}, kind ${info.kind}, mode ${info.deploymentMode}, payments ${info.paymentProvider ?? 'mock'}.`,
);
// A copy that takes real payments runs the read-only check only: --full would create tips.
if (info.paymentsLive && values.full)
  stop('--full refused: this copy takes real payments.', 1);
if (values.full && info.kind !== 'test')
  stop(
    `--full refused: this copy says RELEASE_KIND=${info.kind}. Run the read-only check instead.`,
  );
if (values.full)
  for (const name of [
    'RELEASE_CHECK_TOKEN',
    'RELEASE_OPS_EMAIL',
    'RELEASE_OPS_TOTP_SECRET',
  ])
    if (!process.env[name]) stop(`--full needs ${name} in the environment.`);
// Copies from before the field existed only had pretend payments.
const paymentProvider = info.paymentProvider ?? 'mock';
if (values['expect-provider'] && paymentProvider !== values['expect-provider'])
  stop(
    `this copy takes payments through ${paymentProvider}, expected ${values['expect-provider']}.`,
    1,
  );
const bachsHandle = process.env.RELEASE_BACHS_HANDLE || 'release_bachs';
if (values.full && paymentProvider === 'bachs-sandbox') {
  // Checked before any browser starts, so a missing setup fails in seconds and says what to do.
  const headers = {};
  if (process.env.RELEASE_PREVIEW_PASSWORD) {
    const { previewServerKey } =
      await import('../packages/domain/dist/index.js');
    headers['x-tipme-preview-key'] = previewServerKey(
      process.env.RELEASE_PREVIEW_PASSWORD,
    );
  }
  const page = await fetch(
    `${api}/v1/profiles/${encodeURIComponent(bachsHandle)}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  ).catch((error) => stop(`could not read @${bachsHandle} (${error.message})`));
  const setup =
    'create it on this copy and finish its Bachs sandbox payment setup (docs/runbooks/staging-setup.md).';
  if (page.status === 404)
    stop(
      `this copy takes tips through Bachs, and has no page @${bachsHandle}: ${setup}`,
    );
  if (!page.ok) stop(`could not read @${bachsHandle} (HTTP ${page.status})`);
  if ((await page.json()).data?.acceptingTips === false)
    stop(`@${bachsHandle} can’t take tips yet: ${setup}`);
}
// The Bachs webhook must be there and must authenticate before it does anything: an unsigned
// call answers 401. (The mock provider's endpoint differs, so it is not asked.) Read-only: the
// call carries no signature and creates nothing.
if (!values.full && paymentProvider !== 'mock') {
  const webhook = await fetch(`${api}/v1/webhooks/bachs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(15_000),
  }).catch((error) =>
    stop(`could not reach the Bachs webhook (${error.message})`, 1),
  );
  if (webhook.status !== 401)
    stop(
      `the Bachs webhook answered ${webhook.status} to an unsigned call, expected 401.`,
      1,
    );
}
if (info.deploymentMode === 'preview' && !process.env.RELEASE_PREVIEW_PASSWORD)
  stop('this is a preview copy: set RELEASE_PREVIEW_PASSWORD.');

const result = spawnSync(
  'pnpm',
  ['exec', 'playwright', 'test', '-c', 'tests/release/playwright.config.ts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      RELEASE_WEB: web,
      RELEASE_API: api,
      RELEASE_FULL: values.full ? '1' : '0',
      RELEASE_HANDLE: values.handle ?? '',
      RELEASE_EXPECT_VERSION: values['expect-version'] ?? '',
      RELEASE_INSECURE: values.insecure ? '1' : '0',
      RELEASE_PAYMENT_PROVIDER: paymentProvider,
      RELEASE_BACHS_HANDLE: bachsHandle,
    },
  },
);
console.log(
  result.status === 0
    ? `Release check PASSED (${values.full ? 'full' : 'read-only'}).`
    : 'Release check FAILED. See the report above and test-results/.',
);
process.exit(result.status ?? 1);
