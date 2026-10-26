#!/usr/bin/env node
// Local staging proof (PR-010): runs the staging stack (Caddy, API, worker, Postgres, Redis, backup)
// with the server's compose file plus a local override, and the web app with `next start` standing
// in for Vercel. Usage: node scripts/staging-local.mjs up|down|deploy <tag>|env
//
// Everything is local: https://staging.localhost:8443 and https://api.staging.localhost:8443.
// Secrets are generated into deploy/local/staging.local.env (git-ignored) and never printed.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
} from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const ENV_FILE = 'deploy/local/staging.local.env';
const BACKUPS = 'deploy/local/data/backups';
const WEB_PID = 'deploy/local/data/web.pid';
const LOCAL = {
  web: 'https://staging.localhost:8443',
  api: 'https://api.staging.localhost:8443',
};

const secret = (n = 32) => randomBytes(n).toString('base64url');
function ensureEnv() {
  if (existsSync(ENV_FILE)) return;
  mkdirSync('deploy/local/data/backups', { recursive: true });
  const lines = {
    API_HOST: 'api.staging.localhost',
    ACME_EMAIL: 'local@example.invalid',
    WEB_ORIGIN: LOCAL.web,
    WEB_REVALIDATE_URL: 'http://host.docker.internal:3200/api/revalidate',
    PREVIEW_COOKIE_DOMAIN: 'staging.localhost',
    NODE_ENV: 'production',
    DEPLOYMENT_MODE: 'preview',
    RELEASE_KIND: 'test',
    HOST: '0.0.0.0',
    PORT: '4000',
    TRUST_PROXY_HOPS: '1',
    PAYMENT_PROVIDER: 'mock',
    PAYMENTS_LIVE_ENABLED: 'false',
    MESSAGING_PROVIDER: 'mock',
    ANALYTICS_ENABLED: 'true',
    // The release check and e2e send many requests from one address.
    RATE_LIMIT_AUTH_PER_HOUR: '10000',
    RATE_LIMIT_QUOTES_PER_MIN: '10000',
    RATE_LIMIT_INTENTS_PER_MIN: '10000',
    RATE_LIMIT_HANDLES_PER_MIN: '10000',
    RATE_LIMIT_ANALYTICS_PER_MIN: '10000',
    // Drills sign the release-check staff in many times an hour; real copies keep 3.
    RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR: '100',
    POSTGRES_PASSWORD: secret(24),
    POSTGRES_RUNTIME_PASSWORD: secret(24),
    POSTGRES_MIGRATOR_PASSWORD: secret(24),
    POSTGRES_BACKUP_PASSWORD: secret(24),
    PREVIEW_PASSWORD: secret(),
    MOCK_PROVIDER_WEBHOOK_SECRET: secret(),
    STATUS_TOKEN_SECRET: secret(),
    AUTH_CODE_SECRET: secret(),
    WEB_REVALIDATE_SECRET: secret(),
    OPS_TOTP_KEY: randomBytes(32).toString('base64'),
    RELEASE_CHECK_TOKEN: secret(),
    BACKUP_KEY: randomBytes(32).toString('base64'),
    BACKUP_RETAIN: '14',
  };
  writeFileSync(
    ENV_FILE,
    `${Object.entries(lines)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`,
    { mode: 0o600 },
  );
  console.log(`Generated ${ENV_FILE} (values not shown).`);
}

function readEnv() {
  return Object.fromEntries(
    readFileSync(ENV_FILE, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

const compose = (tag, args, extraEnv = {}) =>
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'deploy/compose.staging.yml',
      '-f',
      'deploy/local/compose.local.yml',
      '--env-file',
      ENV_FILE,
      ...args,
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        TIPME_VERSION: tag,
        TIPME_ENV_FILE: `${process.cwd()}/${ENV_FILE}`,
        TIPME_BACKUP_DIR: `${process.cwd()}/${BACKUPS}`,
        CADDYFILE: `${process.cwd()}/deploy/local/Caddyfile`,
        ...extraEnv,
      },
    },
  );

const curlOk = (url) => {
  try {
    execFileSync('curl', ['-skf', '-o', '/dev/null', url], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
async function waitFor(url, label, seconds = 120) {
  for (let i = 0; i < seconds; i++) {
    if (curlOk(url)) return;
    await sleep(1000);
  }
  throw new Error(`${label} did not become ready`);
}

/** Deploys an image tag the way deploy.sh does on the server: backup, migrate, switch. */
async function deploy(tag) {
  ensureEnv();
  compose(tag, ['up', '-d', '--wait', 'postgres', 'redis']);
  compose(tag, [
    'exec',
    '-T',
    'postgres',
    'sh',
    '/opt/tipme/bootstrap-roles.sh',
  ]);
  compose(tag, [
    'run',
    '--rm',
    'backup',
    'sh',
    'deploy/backup-loop.sh',
    'once',
  ]);
  compose(tag, ['run', '--rm', 'migrate'], {
    MIGRATE_CONFIRM_DATABASE: 'tipme',
    MIGRATE_BACKUP_DONE: '1',
  });
  compose(tag, [
    'exec',
    '-T',
    'postgres',
    'sh',
    '/opt/tipme/bootstrap-roles.sh',
  ]);
  compose(tag, [
    'up',
    '-d',
    '--remove-orphans',
    'api',
    'worker',
    'caddy',
    'backup',
  ]);
  await waitFor(`${LOCAL.api}/health/ready`, 'the API');
}

function buildWeb() {
  const env = readEnv();
  execFileSync('pnpm', ['--filter', '@tipme/web', 'build'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NEXT_PUBLIC_API_ORIGIN: LOCAL.api,
      NEXT_PUBLIC_PRETEND_DELIVERY: 'on',
      NEXT_PUBLIC_PREVIEW_GATE: 'on',
      SITE_URL: LOCAL.web,
      WEB_REVALIDATE_SECRET: env.WEB_REVALIDATE_SECRET,
    },
  });
}

async function startWeb() {
  const env = readEnv();
  const log = openSync('deploy/local/data/web.log', 'a');
  const child = spawn(
    'pnpm',
    ['--filter', '@tipme/web', 'start', '--port', '3200'],
    {
      detached: true,
      stdio: ['ignore', log, log],
      env: {
        ...process.env,
        // next start binds 127.0.0.1; Caddy reaches it via host.docker.internal on Docker Desktop.
        API_INTERNAL_ORIGIN: 'http://127.0.0.1:4500',
        PREVIEW_PASSWORD: env.PREVIEW_PASSWORD,
        PREVIEW_COOKIE_DOMAIN: env.PREVIEW_COOKIE_DOMAIN,
        WEB_REVALIDATE_SECRET: env.WEB_REVALIDATE_SECRET,
        SITE_URL: LOCAL.web,
      },
    },
  );
  child.unref();
  writeFileSync(WEB_PID, String(child.pid));
  await waitFor(`${LOCAL.web}/preview-login`, 'the web app');
}

function stopWeb() {
  if (!existsSync(WEB_PID)) return;
  try {
    process.kill(-Number(readFileSync(WEB_PID, 'utf8')));
  } catch {
    // already stopped
  }
}

const gitTag = () =>
  execFileSync('git', ['rev-parse', '--short=12', 'HEAD']).toString().trim();

const [command, arg] = process.argv.slice(2);
if (command === 'up') {
  const tag = arg ?? gitTag();
  execFileSync(
    'docker',
    ['build', '-f', 'deploy/Dockerfile', '-t', `tipme-app:${tag}`, '.'],
    {
      stdio: 'inherit',
    },
  );
  await deploy(tag);
  buildWeb();
  stopWeb();
  await startWeb();
  console.log(
    `Local staging is up: ${LOCAL.web} (API ${LOCAL.api}), version ${tag}.`,
  );
} else if (command === 'deploy') {
  if (!arg) throw new Error('usage: deploy <image tag>');
  await deploy(arg);
  console.log(`Deployed ${arg}.`);
} else if (command === 'release-staff') {
  // Grants the release-check role in the container and enrols its authenticator; the phone and
  // secret go into the local env file only.
  const env = readEnv();
  const phone = '+2348090000101';
  const output = execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'deploy/compose.staging.yml',
      '-f',
      'deploy/local/compose.local.yml',
      '--env-file',
      ENV_FILE,
      'run',
      '--rm',
      '-e',
      'TIPME_CONFIRM_DATABASE=tipme',
      'migrate',
      'node',
      'packages/database/dist/scripts/grant-owner.js',
      '--phone',
      phone,
      '--role',
      'release_check',
    ],
    {
      env: {
        ...process.env,
        TIPME_VERSION: arg ?? gitTag(),
        TIPME_ENV_FILE: `${process.cwd()}/${ENV_FILE}`,
        TIPME_BACKUP_DIR: `${process.cwd()}/${BACKUPS}`,
        CADDYFILE: `${process.cwd()}/deploy/local/Caddyfile`,
      },
    },
  ).toString();
  const enrolmentCode = /enrolment code \(30 minutes\): ([A-Z2-7]{10})/.exec(
    output,
  )?.[1];
  if (!enrolmentCode)
    throw new Error('the grant command printed no enrolment code');
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const { enrolReleaseStaff } = await import('./release-enrol.mjs');
  const secret = await enrolReleaseStaff({
    web: LOCAL.web,
    api: LOCAL.api,
    password: env.PREVIEW_PASSWORD,
    token: env.RELEASE_CHECK_TOKEN,
    phone,
    enrolmentCode,
  });
  const lines = readFileSync(ENV_FILE, 'utf8')
    .split('\n')
    .filter((l) => l && !l.startsWith('RELEASE_OPS_'));
  lines.push(`RELEASE_OPS_PHONE=${phone}`, `RELEASE_OPS_TOTP_SECRET=${secret}`);
  writeFileSync(ENV_FILE, `${lines.join('\n')}\n`, { mode: 0o600 });
  console.log(
    'Release-check staff enrolled (secret stored in the local env file only).',
  );
} else if (command === 'check') {
  // The release check against the local stack: `check` (read-only) or `check full`.
  const env = readEnv();
  const result = spawnSync(
    'node',
    [
      'scripts/release-check.mjs',
      '--web',
      LOCAL.web,
      '--api',
      LOCAL.api,
      '--insecure',
      ...(arg === 'full' ? ['--full'] : []),
      ...process.argv.slice(4),
    ],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        RELEASE_PREVIEW_PASSWORD: env.PREVIEW_PASSWORD,
        RELEASE_CHECK_TOKEN: env.RELEASE_CHECK_TOKEN,
        RELEASE_OPS_PHONE: env.RELEASE_OPS_PHONE ?? '',
        RELEASE_OPS_TOTP_SECRET: env.RELEASE_OPS_TOTP_SECRET ?? '',
      },
    },
  );
  process.exitCode = result.status ?? 1;
} else if (command === 'rollback') {
  // As deploy/scripts/rollback.sh: switch back to an earlier image, no migration.
  if (!arg) throw new Error('usage: rollback <image tag>');
  compose(arg, [
    'up',
    '-d',
    '--remove-orphans',
    'api',
    'worker',
    'caddy',
    'backup',
  ]);
  for (let i = 0; i < 120; i++) {
    const out = execFileSync('curl', [
      '-sk',
      `${LOCAL.api}/health/release`,
    ]).toString();
    if (out.includes(`"version":"${arg}"`)) break;
    await sleep(1000);
  }
  await waitFor(`${LOCAL.api}/health/ready`, 'the API');
  console.log(`Rolled back to ${arg}.`);
} else if (command === 'down') {
  stopWeb();
  ensureEnv();
  compose('down', ['down']);
} else if (command === 'web') {
  stopWeb();
  await startWeb();
} else if (command && command !== 'env') {
  console.error(
    'usage: node scripts/staging-local.mjs up [tag] | deploy <tag> | down | web',
  );
  process.exitCode = 1;
}
