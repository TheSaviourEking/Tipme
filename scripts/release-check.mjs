#!/usr/bin/env node
// The release check (PR-010): `pnpm release:check --web <url> --api <url> [--full]`.
//
// Read-only by default: safe on any copy, it creates nothing. `--full` plays the whole story
// (tip → dashboard → withdrawal → admin issue) as a tagged rehearsal and cleans up after itself,
// and only on a copy that declares RELEASE_KIND=test. Secrets come from the environment, never
// the command line: RELEASE_PREVIEW_PASSWORD, RELEASE_CHECK_TOKEN, RELEASE_OPS_PHONE,
// RELEASE_OPS_TOTP_SECRET.
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    web: { type: 'string' },
    api: { type: 'string' },
    full: { type: 'boolean', default: false },
    handle: { type: 'string' },
    'expect-version': { type: 'string' },
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
  `Release check against ${web} (API ${api}): version ${info.version}, kind ${info.kind}, mode ${info.deploymentMode}.`,
);
if (info.paymentsLive)
  stop('this copy reports LIVE payments; stopping before anything else.', 1);
if (values.full && info.kind !== 'test')
  stop(
    `--full refused: this copy says RELEASE_KIND=${info.kind}. Run the read-only check instead.`,
  );
if (values.full)
  for (const name of [
    'RELEASE_CHECK_TOKEN',
    'RELEASE_OPS_PHONE',
    'RELEASE_OPS_TOTP_SECRET',
  ])
    if (!process.env[name]) stop(`--full needs ${name} in the environment.`);
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
    },
  },
);
console.log(
  result.status === 0
    ? `Release check PASSED (${values.full ? 'full' : 'read-only'}).`
    : 'Release check FAILED. See the report above and test-results/.',
);
process.exit(result.status ?? 1);
