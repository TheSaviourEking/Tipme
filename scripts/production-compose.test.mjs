import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// deploy/compose.production.yml, parsed by Docker Compose itself (the repo has no YAML parser at
// the root). Variables get dummy values, never real secrets; without Docker these tests skip.
const composeUrl = new URL('../deploy/compose.production.yml', import.meta.url);
const envExampleUrl = new URL(
  '../deploy/production.env.example',
  import.meta.url,
);
const raw = readFileSync(composeUrl, 'utf8');
const readVars = [...raw.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]);

const haveDocker =
  !spawnSync('docker', ['compose', 'version']).error &&
  spawnSync('docker', ['compose', 'version']).status === 0;
// In CI a missing docker must fail the run, never skip these tests silently.
const skip = haveDocker
  ? false
  : process.env.CI
    ? false
    : 'docker compose is not available';
if (!haveDocker && process.env.CI)
  test('docker compose is available (required in CI)', () => {
    assert.fail(
      'docker compose is not available, so the structural tests cannot run',
    );
  });

const dummyEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
for (const name of readVars) dummyEnv[name] = 'dummy';
// A path, so the CA mount is a bind mount rather than a named volume.
dummyEnv.TIPME_HOME = '/srv/dummy-home';

const parse = (env = dummyEnv) => {
  const result = spawnSync(
    'docker',
    [
      'compose',
      '-f',
      composeUrl.pathname,
      '--profile',
      'tools',
      'config',
      '--format',
      'json',
    ],
    { encoding: 'utf8', env },
  );
  assert.equal(result.status, 0, `compose config failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
};

const stagingHome = '/srv/tipme/';

test(
  'production passes every setting the API and worker read (no silent defaults)',
  { skip },
  () => {
    const config = parse();
    // Deliberately not passed: Task 1 makes a production copy refuse them, or they are test-only.
    const deliberate = new Set([
      'PREVIEW_PASSWORD',
      'PREVIEW_COOKIE_DOMAIN',
      'MAIL_PRETEND_DOMAINS',
      'RELEASE_CHECK_TOKEN',
      'TRACE_PROBE_TEST_DELAY_MS',
      // The live stream's heartbeat: tests shorten it; production keeps the 20 s default.
      'LIVE_HEARTBEAT_MS',
      // The mock provider's secret: production never runs the mock provider.
      'MOCK_PROVIDER_WEBHOOK_SECRET',
      // A tunable with a code default (owner, 14 Nov 2026, #216: deploy settings are secrets and
      // addresses only); still an override in the schema for an emergency.
      'ANNOUNCEMENT_SENDS_PER_MINUTE',
    ]);
    const services = {
      api: ['api-blue', 'api-green'],
      worker: ['worker-a', 'worker-b'],
    };
    for (const [kind, names] of Object.entries(services)) {
      const source = readFileSync(
        new URL(`../apps/${kind}/src/config.ts`, import.meta.url),
        'utf8',
      );
      const read = [...source.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map(
        (m) => m[1],
      );
      assert.ok(read.length > 5, `${kind}: no settings found`);
      for (const name of names) {
        const passed = config.services[name].environment;
        const missing = read.filter(
          (k) => !(k in passed) && !deliberate.has(k) && !CODE_DEFAULT_ONLY(k),
        );
        assert.deepEqual(missing, [], `${name} settings missing from compose`);
        for (const key of deliberate)
          assert.ok(!(key in passed), `${name} must not pass ${key}`);
        assert.equal(passed.DEPLOYMENT_MODE, 'production');
        assert.equal(passed.NODE_ENV, 'production');
        assert.equal(passed.SENTRY_ENVIRONMENT, 'production');
        assert.equal(passed.RELEASE_KIND, 'live');
      }
    }
    for (const name of ['api-blue', 'api-green']) {
      const env = config.services[name].environment;
      assert.equal(env.TRUST_PROXY_HOPS, '1');
      assert.equal(env.HOST, '0.0.0.0');
      assert.equal(env.POINT_IN_TIME_RECOVERY, 'off');
    }
  },
);

test(
  'production has no database, backup, caddy or preview service and publishes no port',
  { skip },
  () => {
    const { services } = parse();
    assert.deepEqual(Object.keys(services).sort(), [
      'api-blue',
      'api-green',
      'db-roles',
      'migrate',
      'redis',
      'worker-a',
      'worker-b',
    ]);
    for (const forbidden of [
      'postgres',
      'backup',
      'retention',
      'restore',
      'caddy',
      'preview',
    ])
      assert.ok(!(forbidden in services), `unexpected service ${forbidden}`);
    for (const [name, service] of Object.entries(services))
      assert.ok(!service.ports, `${name} publishes a port`);
  },
);

test(
  'production names its project, leaves container names to Compose and wires the colours',
  { skip },
  () => {
    const config = parse();
    assert.equal(config.name, 'tipme-production');
    for (const [name, service] of Object.entries(config.services))
      assert.ok(!('container_name' in service), `${name} sets container_name`);
    for (const colour of ['api-blue', 'api-green']) {
      const service = config.services[colour];
      assert.equal(service.deploy.replicas, 3);
      assert.deepEqual(Object.keys(service.networks).sort(), [
        'edge-production',
        'egress',
        'internal',
      ]);
      assert.equal(service.mem_limit, String(384 * 1024 * 1024));
      assert.equal(service.stop_grace_period, '20s');
      // Two failed 2 s readiness checks take a draining copy out (up to ~6 s): drain 7 s, then
      // the 10 s close deadline, inside the 20 s stop grace.
      assert.equal(service.environment.SHUTDOWN_DRAIN_MS, '7000');
      assert.match(service.healthcheck.test.join(' '), /\/health\/ready/);
    }
    assert.equal(config.services['api-blue'].image, 'tipme-app:dummy');
    assert.equal(config.networks['edge-production'].external, true);
    assert.equal(config.networks.internal.internal, true);
    assert.ok(
      !config.networks.egress.internal && !config.networks.egress.external,
    );
    assert.deepEqual(Object.keys(config.services.redis.networks), ['internal']);
    for (const worker of ['worker-a', 'worker-b'])
      assert.deepEqual(Object.keys(config.services[worker].networks).sort(), [
        'egress',
        'internal',
      ]);
    assert.match(config.services.redis.command.join(' '), /--appendonly yes/);
    assert.ok(config.volumes.redisdata);
  },
);

test(
  'every Postgres client mounts the CA read-only and no service mounts a staging path',
  { skip },
  () => {
    const { services } = parse();
    const clients = [
      'api-blue',
      'api-green',
      'worker-a',
      'worker-b',
      'migrate',
      'db-roles',
    ];
    for (const name of clients) {
      const ca = (services[name].volumes ?? []).find(
        (v) => v.target === '/run/secrets/db-ca.pem',
      );
      assert.ok(ca, `${name} does not mount the CA`);
      assert.equal(ca.read_only, true, `${name} mounts the CA writable`);
      assert.equal(ca.source, '/srv/dummy-home/db-ca.pem');
    }
    for (const [name, service] of Object.entries(services))
      for (const volume of service.volumes ?? [])
        assert.ok(
          !String(volume.source ?? '').startsWith(stagingHome),
          `${name} mounts a staging path`,
        );
    assert.equal(services['db-roles'].profiles[0], 'tools');
    assert.equal(services.migrate.profiles[0], 'tools');
    assert.deepEqual(services['db-roles'].command, [
      'node',
      'packages/database/dist/scripts/db-roles.js',
    ]);
    for (const key of [
      'DATABASE_ADMIN_URL',
      'POSTGRES_RUNTIME_PASSWORD',
      'POSTGRES_MIGRATOR_PASSWORD',
      'POSTGRES_BACKUP_PASSWORD',
    ])
      assert.ok(
        key in services['db-roles'].environment,
        `db-roles lacks ${key}`,
      );
    assert.ok(!('DATABASE_ADMIN_URL' in services['api-blue'].environment));
  },
);

test(
  'the migrate and db-roles tools run the TIPME_VERSION image',
  { skip },
  () => {
    const { services } = parse();
    for (const name of ['migrate', 'db-roles', 'worker-a', 'worker-b'])
      assert.equal(services[name].image, 'tipme-app:dummy');
    assert.match(raw, /image: tipme-app:\$\{TIPME_VERSION/);
  },
);

const CAPPED_LOGS = {
  driver: 'json-file',
  options: { 'max-size': '10m', 'max-file': '3' },
};

test('every production service caps its json-file logs', { skip }, () => {
  const { services } = parse();
  for (const name of ['api-blue', 'api-green', 'worker-a', 'worker-b', 'redis'])
    assert.ok(name in services, `${name} is missing`);
  for (const [name, service] of Object.entries(services))
    assert.deepEqual(service.logging, CAPPED_LOGS, `${name} has no log limit`);
});

// Staging shares its server's disk with production: on 21 Nov 2026 a staging worker logging a full
// Redis's error ~3,000 times a second wrote 26 GB, filled the disk and took production down.
test(
  'every staging service caps its json-file logs, as production does',
  { skip },
  () => {
    const stagingUrl = new URL(
      '../deploy/compose.staging.yml',
      import.meta.url,
    );
    const stagingRaw = readFileSync(stagingUrl, 'utf8');
    const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' };
    for (const [, name] of stagingRaw.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g))
      // A path for directories and files, so bind mounts stay bind mounts.
      env[name] = /_(DIR|FILE)$/.test(name) ? '/srv/dummy' : 'dummy';
    const result = spawnSync(
      'docker',
      [
        'compose',
        '-f',
        stagingUrl.pathname,
        '--profile',
        'tools',
        '--profile',
        'offsite',
        'config',
        '--format',
        'json',
      ],
      { encoding: 'utf8', env },
    );
    assert.equal(result.status, 0, `compose config failed: ${result.stderr}`);
    const { services } = JSON.parse(result.stdout);
    for (const name of [
      'api',
      'worker',
      'postgres',
      'redis',
      'offsite',
      'backup',
    ])
      assert.ok(name in services, `${name} is missing`);
    for (const [name, service] of Object.entries(services))
      assert.deepEqual(
        service.logging,
        CAPPED_LOGS,
        `${name} has no log limit`,
      );
  },
);

// Not Docker-dependent.
test('production.env.example names every ${VAR} the compose file reads, with no values for secrets', () => {
  const example = readFileSync(envExampleUrl, 'utf8');
  const lines = example.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
  const values = new Map(
    lines.map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]),
  );
  // The moved switches are forwarded for one release only, as seeds (SEED_ONLY below).
  const missing = [...new Set(readVars)].filter(
    (v) => !values.has(v) && !SEED_ONLY.includes(v),
  );
  assert.deepEqual(
    missing,
    [],
    'variables the compose file reads but the example omits',
  );
  const secret =
    /PASSWORD|SECRET|_KEY\b|_KEY_ID|TOKEN|DSN|DATABASE_(ADMIN_)?URL|MIGRATION_DATABASE_URL|TOTP/;
  for (const [name, value] of values)
    if (secret.test(name))
      assert.equal(value, '', `${name} must be blank in the example`);
  assert.match(example, /openssl rand/);
  assert.match(example, /^# .*SITE_INDEXING.*Vercel/m);
  assert.ok(!values.has('SITE_INDEXING'));
});

test('payment and mail settings have no silent default in the compose file', () => {
  for (const name of [
    'PAYMENT_PROVIDER',
    'MAIL_DEFAULT_PROVIDER',
    'MAIL_FROM_DOMAIN',
  ]) {
    const uses = [...raw.matchAll(new RegExp(`\\$\\{${name}([^}]*)\\}`, 'g'))];
    assert.ok(uses.length > 0, `${name} is not read`);
    for (const use of uses)
      assert.match(
        use[1],
        /^:\?/,
        `${name} must be required (:?), not defaulted`,
      );
  }
});

test('production.env.example gives the non-secret production values', () => {
  const example = readFileSync(envExampleUrl, 'utf8');
  const value = (name) => new RegExp(`^${name}=(.*)$`, 'm').exec(example)?.[1];
  assert.equal(value('MAIL_DEFAULT_PROVIDER'), 'zeptomail');
  assert.equal(value('MAIL_FROM_DOMAIN'), 'usetipme.xyz');
  assert.equal(value('MAIL_FROM_NAME'), 'TipMe');
  assert.equal(value('MAIL_REPLY_TO'), 'support@usetipme.xyz');
  assert.equal(value('PAYMENT_PROVIDER'), 'bachs-live');
  assert.equal(value('API_HOST'), 'api.usetipme.xyz');
  // The deploy's health wait checks the public host unless a rehearsal overrides it.
  assert.equal(value('HEALTH_BASE_URL'), '');
  assert.match(
    example,
    /^# .*payments plan.*bachs-live|^# .*bachs-live.*payments plan/im,
  );
});

test(
  'the deploy states the real number of processes sharing the budget',
  { skip },
  () => {
    const config = parse();
    const colours = ['api-blue', 'api-green'];
    const workers = ['worker-a', 'worker-b'];
    const copies = colours.reduce(
      (sum, name) => sum + config.services[name].deploy.replicas,
      0,
    );
    for (const name of [...colours, ...workers]) {
      const { environment } = config.services[name];
      assert.equal(Number(environment.DATABASE_BUDGET_API_PROCESSES), copies);
      assert.equal(
        Number(environment.DATABASE_BUDGET_WORKER_PROCESSES),
        workers.length,
      );
    }
  },
);

test('every app service notices a dead connection soon', { skip }, () => {
  const config = parse();
  for (const name of [
    'api-blue',
    'api-green',
    'worker-a',
    'worker-b',
    'migrate',
  ])
    assert.equal(
      String(config.services[name].sysctls['net.ipv4.tcp_retries2']),
      '8',
      name,
    );
});

// Feature switches (owner, 14 Nov 2026; docs/runbooks/settings-and-switches.md): set in admin now. The
// compose files forward the old variables for one release, so the first start seeds each switch from
// the server's current value; nothing defaults them here. The examples no longer name them.
export const SEED_ONLY = [
  'PRO_BILLING_ENABLED',
  'PRO_PAY_FROM_BALANCE',
  'PRO_REFUNDS',
  'PRO_AUTO_RENEW',
  'BUSINESS_ENABLED',
  'BUSINESS_SHARES_ENABLED',
  'TEAM_TIPS_ENABLED',
  'ANALYTICS_ENABLED',
  'ADULT_PLATFORM_LINKS',
  'SUPPORTER_RECOGNITION',
];

test('the env examples no longer name the switches that moved to admin', () => {
  for (const file of ['production.env.example', 'staging.env.example']) {
    const example = readFileSync(
      new URL(`../deploy/${file}`, import.meta.url),
      'utf8',
    );
    for (const name of SEED_ONLY)
      assert.doesNotMatch(
        example,
        new RegExp(`^${name}=`, 'm'),
        `${file} still sets ${name}`,
      );
    assert.match(
      example,
      /settings-and-switches\.md/,
      `${file} says where they went`,
    );
  }
});

test('compose forwards each moved switch for one release, with no default of its own', () => {
  for (const file of ['compose.production.yml', 'compose.staging.yml']) {
    const text = readFileSync(
      new URL(`../deploy/${file}`, import.meta.url),
      'utf8',
    );
    for (const name of SEED_ONLY) {
      const uses = [
        ...text.matchAll(new RegExp(`\\$\\{${name}([^}]*)\\}`, 'g')),
      ];
      assert.ok(uses.length > 0, `${file} no longer forwards ${name}`);
      for (const use of uses)
        assert.equal(
          use[1],
          ':-',
          `${file}: ${name} must default to blank (seed only)`,
        );
    }
  }
});

// Page Studio is the `page_studio` switch alone (owner, 14 Nov 2026: as few variables as possible). It
// never shipped as a setting, so no deploy file forwards, defaults or documents a variable for it.
test('no deploy file names PAGE_STUDIO_ENABLED: Page Studio is set in admin only', () => {
  for (const file of [
    'compose.production.yml',
    'compose.staging.yml',
    'production.env.example',
    'staging.env.example',
  ]) {
    const text = readFileSync(
      new URL(`../deploy/${file}`, import.meta.url),
      'utf8',
    );
    assert.doesNotMatch(text, /PAGE_STUDIO_ENABLED/, `${file} names it`);
  }
});

// Owner, 14 Nov 2026 (#216): limits and money tunables take the code's defaults on every copy. The
// config keeps each as an optional override, for tests and emergencies; the deploy files name none.
export const CODE_DEFAULT_ONLY = (name) =>
  name.startsWith('RATE_LIMIT_') ||
  name === 'PARTNER_QUOTE_CACHE_SECONDS' ||
  name === 'BACHS_RESERVE_ALERT_MINOR';

test('rate limits and money tunables are in no deploy file: the code defaults are the values', () => {
  for (const file of [
    'compose.production.yml',
    'compose.staging.yml',
    'production.env.example',
    'staging.env.example',
  ]) {
    const text = readFileSync(
      new URL(`../deploy/${file}`, import.meta.url),
      'utf8',
    );
    const named = [...text.matchAll(/\b([A-Z][A-Z0-9_]+)\b/g)]
      .map((m) => m[1])
      .filter(CODE_DEFAULT_ONLY);
    assert.deepEqual([...new Set(named)], [], `${file} still names them`);
  }
  // Still overridable: the schemas keep them.
  for (const service of ['api', 'worker']) {
    const source = readFileSync(
      new URL(`../apps/${service}/src/config.ts`, import.meta.url),
      'utf8',
    );
    const kept = [...source.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)]
      .map((m) => m[1])
      .filter(CODE_DEFAULT_ONLY);
    assert.ok(kept.length > 0, `${service} lost its overrides`);
  }
});

// The owner, 14 Nov 2026 (#216): keep deploy settings to a minimum. Secrets and the sender stay;
// tunables and dev toggles use code defaults (still overridable in the config schemas).
test('announcement email: secrets and the sender are deploy settings, tunables are not', () => {
  const files = [
    'deploy/compose.production.yml',
    'deploy/compose.staging.yml',
    'deploy/production.env.example',
    'deploy/staging.env.example',
  ].map((path) => [
    path,
    readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'),
  ]);
  for (const [path, text] of files) {
    for (const tunable of [
      'ANNOUNCEMENT_SENDS_PER_MINUTE',
      'BREVO_SANDBOX',
      'BREVO_TRANSACTIONAL_SANDBOX',
      'BREVO_API_BASE',
    ])
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${tunable}\\b`),
        `${path}: ${tunable}`,
      );
    for (const setting of [
      'BREVO_API_KEY',
      'BREVO_WEBHOOK_TOKEN',
      'ANNOUNCEMENT_FROM_ADDRESS',
      // Codes and receipts through Brevo (owner, 23 Nov 2026): an opt-in, like the default provider.
      'BREVO_TRANSACTIONAL',
    ])
      assert.match(text, new RegExp(`\\b${setting}\\b`), `${path}: ${setting}`);
  }
});

// Automatic email failover (owner, 23 Nov 2026): the fallback list is a deploy setting (empty by
// default, like the default provider); the breaker and code-signal numbers are code defaults.
test('mail failover: the fallback list is a deploy setting, its tunables are not', () => {
  for (const path of [
    'deploy/compose.production.yml',
    'deploy/compose.staging.yml',
    'deploy/production.env.example',
    'deploy/staging.env.example',
  ]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(
      text,
      /\bMAIL_FALLBACK_PROVIDERS\b/,
      `${path}: MAIL_FALLBACK_PROVIDERS`,
    );
    for (const tunable of [
      'MAIL_BREAKER_FAILURES',
      'MAIL_BREAKER_WINDOW_MS',
      'MAIL_BREAKER_REST_MS',
      'MAIL_CODE_UNUSED_AFTER_MS',
      'MAIL_CODE_WINDOW_MS',
      'MAIL_CODE_MIN_SAMPLES',
      'MAIL_CODE_UNUSED_RATIO',
      'MAIL_CODE_TRIAL_CODES',
      'MAIL_RESEND_WINDOW_MS',
    ])
      assert.doesNotMatch(
        text,
        new RegExp(`\\b${tunable}\\b`),
        `${path}: ${tunable}`,
      );
  }
  // Empty by default in compose, so nothing changes until it is set.
  for (const path of [
    'deploy/compose.production.yml',
    'deploy/compose.staging.yml',
  ]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    const lines = text.match(/MAIL_FALLBACK_PROVIDERS: .*/g) ?? [];
    assert.equal(lines.length, 2, `${path}: the API and the worker`);
    for (const line of lines)
      assert.equal(
        line,
        'MAIL_FALLBACK_PROVIDERS: ${MAIL_FALLBACK_PROVIDERS:-}',
      );
  }
});
