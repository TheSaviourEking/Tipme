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

const parse = () => {
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
    { encoding: 'utf8', env: dummyEnv },
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
      // The mock provider's secret: production never runs the mock provider.
      'MOCK_PROVIDER_WEBHOOK_SECRET',
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
          (k) => !(k in passed) && !deliberate.has(k),
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

// Not Docker-dependent.
test('production.env.example names every ${VAR} the compose file reads, with no values for secrets', () => {
  const example = readFileSync(envExampleUrl, 'utf8');
  const lines = example.split('\n').filter((l) => /^[A-Z][A-Z0-9_]*=/.test(l));
  const values = new Map(
    lines.map((l) => [l.split('=')[0], l.slice(l.indexOf('=') + 1)]),
  );
  const missing = [...new Set(readVars)].filter((v) => !values.has(v));
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
