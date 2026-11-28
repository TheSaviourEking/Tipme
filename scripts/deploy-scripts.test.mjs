import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { stage } from './test-support/fake-server.mjs';

test('a deploy of a shipped image backs up, migrates with the database named, switches and records it, without git or a build', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  const result = run('deploy.sh', ['aaaaaaa1']);
  assert.equal(result.status, 0, result.stderr);
  const calls = read('calls.log').split('\n');
  const at = (pattern) => calls.findIndex((line) => pattern.test(line));
  const roles = calls.flatMap((line, index) =>
    line.includes('exec -T postgres sh /opt/tipme/bootstrap-roles.sh')
      ? [index]
      : [],
  );
  const backup = at(/run --rm backup/);
  const migrate = at(/run --rm migrate.*confirm=tipme backup=1/);
  const up = at(/up -d --remove-orphans api/);
  assert.ok(
    roles.length === 2 &&
      roles[0] < backup &&
      backup < migrate &&
      migrate < roles[1] &&
      roles[1] < up,
    calls.join('\n'),
  );
  assert.ok(
    calls.some((l) => l.includes('releases/aaaaaaa1/compose.staging.yml')),
    'uses that version’s files',
  );
  assert.equal(at(/docker build/), -1, 'the server never builds');
  assert.equal(at(/^git /), -1, 'the server never fetches code');
  assert.equal(read('releases/current').trim(), 'aaaaaaa1');
  assert.equal(read('running').trim(), 'aaaaaaa1');
});

test('a staging version whose files still define caddy never starts it', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  const result = run('deploy.sh', ['aaaaaaa1']);
  assert.equal(result.status, 0, result.stderr);
  const ups = read('calls.log')
    .split('\n')
    .filter((line) => / up /.test(line));
  assert.ok(
    ups.some((line) => /\bapi\b/.test(line)),
    'the app services start',
  );
  assert.ok(
    ups.every((line) => !/\bcaddy\b/.test(line)),
    ups.join('\n'),
  );
});

test('a missing edge network is refused before anything runs, pointing to the runbook', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  const result = run('deploy.sh', ['aaaaaaa1'], { FAKE_NO_EDGE: '1' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /edge-staging/);
  assert.match(result.stderr, /staging-setup\.md/);
  assert.equal(
    read('calls.log')
      .split('\n')
      .filter((line) => line && !/network inspect/.test(line)).length,
    0,
    'nothing was backed up, migrated or started',
  );
});

test('rolling back to a version from before the edge move attaches its API to edge-staging, once', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  ship('bbbbbbb2');
  const extra = { FAKE_PREMOVE_VERSIONS: 'aaaaaaa1' };
  assert.equal(run('deploy.sh', ['aaaaaaa1'], extra).status, 0);
  assert.equal(run('deploy.sh', ['bbbbbbb2'], extra).status, 0);
  const connects = () =>
    read('calls.log')
      .split('\n')
      .filter((l) => / network connect /.test(l));
  assert.equal(connects().length, 1, 'only the pre-move deploy needed it');
  assert.match(
    connects()[0],
    /network connect --alias staging-api edge-staging api-container/,
  );
  const back = run('rollback.sh', [], extra);
  assert.equal(back.status, 0, back.stderr);
  assert.equal(read('running').trim(), 'aaaaaaa1');
  assert.equal(connects().length, 2, 'the rolled-back API was attached');
  // Already attached: another attach pass does nothing.
  assert.equal(run('rollback.sh', ['aaaaaaa1'], extra).status, 2);
  assert.equal(connects().length, 2);
});

test('an unhealthy deploy puts the previous pre-move version back on edge-staging too', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  ship('ccccccc3');
  const extra = { FAKE_PREMOVE_VERSIONS: 'aaaaaaa1' };
  assert.equal(run('deploy.sh', ['aaaaaaa1'], extra).status, 0);
  const broken = run('deploy.sh', ['ccccccc3'], {
    ...extra,
    FAKE_BROKEN: 'ccccccc3',
  });
  assert.equal(broken.status, 1);
  assert.equal(read('running').trim(), 'aaaaaaa1');
  const calls = read('calls.log').split('\n');
  const restore = calls.findLastIndex(
    (l) => /version=aaaaaaa1/.test(l) && / up /.test(l),
  );
  assert.ok(
    calls.slice(restore).some((l) => / network connect /.test(l)),
    calls.join('\n'),
  );
});

test('a version that was never shipped is refused before anything runs', () => {
  const { run, read } = stage();
  const result = run('deploy.sh', ['ddddddd4']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not loaded|not shipped/);
  assert.equal(read('calls.log').includes('compose'), false);
});

test('rolling back twice never goes forward to the version just backed out', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  ship('bbbbbbb2');
  assert.equal(run('deploy.sh', ['aaaaaaa1']).status, 0);
  assert.equal(run('deploy.sh', ['bbbbbbb2']).status, 0);
  const back = run('rollback.sh');
  assert.equal(back.status, 0, back.stderr);
  assert.equal(read('running').trim(), 'aaaaaaa1');
  assert.equal(read('releases/current').trim(), 'aaaaaaa1');
  const again = run('rollback.sh');
  assert.equal(again.status, 2, 'nothing older than A to roll back to');
  assert.equal(read('running').trim(), 'aaaaaaa1', 'still on A, not back on B');
});

test('an unhealthy new version is replaced by the previous one automatically', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  ship('ccccccc3');
  assert.equal(run('deploy.sh', ['aaaaaaa1']).status, 0);
  const broken = run('deploy.sh', ['ccccccc3'], { FAKE_BROKEN: 'ccccccc3' });
  assert.equal(broken.status, 1);
  assert.equal(read('running').trim(), 'aaaaaaa1');
  assert.equal(read('releases/current').trim(), 'aaaaaaa1');
});

test('the old worker is paused after the backup and before the migrations, then replaced by the switch', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  ship('bbbbbbb2');
  assert.equal(run('deploy.sh', ['aaaaaaa1']).status, 0);
  assert.equal(read('worker').trim(), 'aaaaaaa1');
  const before = read('calls.log').split('\n').filter(Boolean).length;
  const result = run('deploy.sh', ['bbbbbbb2']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /==> Pausing workers for migrations: worker/);
  const calls = read('calls.log').split('\n').filter(Boolean).slice(before);
  const at = (pattern) => calls.findIndex((line) => pattern.test(line));
  const backup = at(/run --rm backup/);
  const pause = at(/ stop worker \|/);
  const migrate = at(/run --rm migrate/);
  const up = at(/up -d --remove-orphans api worker/);
  assert.ok(
    backup < pause && pause < migrate && migrate < up,
    calls.join('\n'),
  );
  assert.equal(at(/ start /), -1, 'never started back on the old version');
  assert.equal(read('worker').trim(), 'bbbbbbb2');
});

test('a failed staging migration starts the paused worker again, unchanged', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  ship('bbbbbbb2');
  assert.equal(run('deploy.sh', ['aaaaaaa1']).status, 0);
  const result = run('deploy.sh', ['bbbbbbb2'], { FAKE_MIGRATE_FAILS: '1' });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /==> Workers resumed \(migrations failed\): worker/,
  );
  const calls = read('calls.log').split('\n').filter(Boolean);
  assert.match(calls.at(-1), / start worker \|/);
  assert.equal(read('worker').trim(), 'aaaaaaa1');
  assert.equal(read('running').trim(), 'aaaaaaa1');
  assert.equal(read('releases/current').trim(), 'aaaaaaa1');
});

test('backups owned by anyone but the image user are refused before a deploy changes anything', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  const result = run('deploy.sh', ['aaaaaaa1'], { FAKE_STAT_UID: '1001' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /uid 1000/);
  assert.equal(read('calls.log'), '', 'nothing was backed up or migrated');
});

test('a database password that would break the connection address is refused before anything runs', () => {
  const { run, read, ship } = stage({ password: 'ab/cd+e=' });
  ship('aaaaaaa1');
  const result = run('deploy.sh', ['aaaaaaa1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /POSTGRES_PASSWORD/);
  assert.equal(read('calls.log'), '', 'nothing was backed up or migrated');
});

test('reused passwords cannot collapse database role separation', () => {
  const { run, read, ship, home } = stage();
  writeFileSync(
    join(home, 'staging.env'),
    `API_HOST=api.staging.example.test\nPOSTGRES_PASSWORD=runtime-password-1234\nPOSTGRES_RUNTIME_PASSWORD=runtime-password-1234\nPOSTGRES_MIGRATOR_PASSWORD=migrator-password-1234\nPOSTGRES_BACKUP_PASSWORD=backup-password-1234\n`,
  );
  ship('aaaaaaa1');
  const result = run('deploy.sh', ['aaaaaaa1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /must be unique/);
  assert.equal(read('calls.log'), '');
});

test('a missing database role password refuses deployment before Compose runs', () => {
  const { run, read, ship, home } = stage();
  writeFileSync(
    join(home, 'staging.env'),
    `API_HOST=api.staging.example.test\nPOSTGRES_PASSWORD=admin-password-123456\nPOSTGRES_RUNTIME_PASSWORD=runtime-password-1234\nPOSTGRES_MIGRATOR_PASSWORD=migrator-password-1234\n`,
  );
  ship('aaaaaaa1');
  const result = run('deploy.sh', ['aaaaaaa1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /POSTGRES_BACKUP_PASSWORD is required/);
  assert.equal(read('calls.log'), '');
});

test('only the last five versions are kept (images and files), so rollback targets stay and the disk does not fill', () => {
  const { run, read, ship, exists } = stage();
  const versions = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map(
    (v) => `${v}00000`,
  );
  for (const version of versions) {
    ship(version);
    assert.equal(run('deploy.sh', [version]).status, 0);
  }
  const images = read('images').trim().split('\n');
  assert.deepEqual(
    images,
    versions.slice(2).map((v) => `tipme-app:${v}`),
  );
  assert.equal(exists(`releases/${versions[0]}`), false);
  assert.equal(exists(`releases/${versions[2]}`), true);
});

test('a version with the retention service starts it; rolling back to one without it still works', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  ship('bbbbbbb2');
  const extra = { FAKE_NEW_VERSIONS: 'bbbbbbb2' };
  assert.equal(run('deploy.sh', ['aaaaaaa1'], extra).status, 0);
  assert.equal(run('deploy.sh', ['bbbbbbb2'], extra).status, 0);
  const ups = read('calls.log')
    .split('\n')
    .filter((l) => / up -d --remove-orphans /.test(l));
  assert.match(ups.at(-1), /api worker backup retention .*version=bbbbbbb2/);
  assert.doesNotMatch(ups[0], /retention/);
  const back = run('rollback.sh', [], extra);
  assert.equal(back.status, 0, back.stderr);
  const last = read('calls.log')
    .split('\n')
    .filter((l) => / up -d --remove-orphans /.test(l))
    .at(-1);
  assert.match(last, /version=aaaaaaa1/);
  assert.doesNotMatch(last, /retention/, 'the old version has no such service');
});

test('/srv/tipme/live always points at the running version’s files, and compose.sh runs compose for it', () => {
  const { run, read, ship, home } = stage();
  ship('aaaaaaa1');
  ship('bbbbbbb2');
  assert.equal(run('deploy.sh', ['aaaaaaa1']).status, 0);
  assert.equal(run('deploy.sh', ['bbbbbbb2']).status, 0);
  assert.equal(
    realpathSync(join(home, 'live')),
    realpathSync(join(home, 'releases/bbbbbbb2')),
  );
  assert.equal(run('rollback.sh').status, 0);
  assert.equal(
    realpathSync(join(home, 'live')),
    realpathSync(join(home, 'releases/aaaaaaa1')),
  );
  const compose = run('compose.sh', ['ps']);
  assert.equal(compose.status, 0, compose.stderr);
  assert.match(
    read('calls.log').trim().split('\n').at(-1),
    /releases\/aaaaaaa1\/compose\.staging\.yml.*ps.*version=aaaaaaa1/,
  );
});

test('rolling back to a version without WAL archiving says so, and how to restore it', () => {
  const { run, ship } = stage();
  ship('aaaaaaa1'); // before PR-011: no archive_mode
  ship('bbbbbbb2', 'services: {}\n# - archive_mode=on\n');
  assert.equal(run('deploy.sh', ['aaaaaaa1']).status, 0);
  assert.equal(run('deploy.sh', ['bbbbbbb2']).status, 0);
  const back = run('rollback.sh');
  assert.equal(back.status, 0, back.stderr);
  assert.match(back.stderr, /WAL archiving is OFF/);
  assert.match(back.stderr, /point-in-time recovery/);
});

test('staging passes every setting the API and worker read (no silent defaults)', () => {
  // Each service gets only the settings listed for it in compose.staging.yml; a setting the
  // config reads but compose does not pass would silently take its default on staging.
  const compose = readFileSync(
    new URL('../deploy/compose.staging.yml', import.meta.url),
    'utf8',
  );
  const passedTo = (service) => {
    const block = compose.split(new RegExp(`^  ${service}:\\n`, 'm'))[1] ?? '';
    const body = block.split(/^  [a-z]/m)[0];
    return new Set(
      [...body.matchAll(/^ {6}([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]),
    );
  };
  // Only for tests: never set on a real copy.
  // LIVE_HEARTBEAT_MS: the live stream's heartbeat; tests shorten it, copies keep 20 s.
  // LIVE_TIP_LIFETIME_MS: a receipt stream's life; tests shorten it, copies keep 15 minutes.
  // ANNOUNCEMENT_SENDS_PER_MINUTE: a tunable with a code default (owner, 14 Nov 2026, #216: keep
  // deploy settings to secrets and addresses); an override stays possible in an emergency.
  const testOnly = new Set([
    'TRACE_PROBE_TEST_DELAY_MS',
    'LIVE_HEARTBEAT_MS',
    'LIVE_TIP_LIFETIME_MS',
    'ANNOUNCEMENT_SENDS_PER_MINUTE',
  ]);
  for (const service of ['api', 'worker']) {
    const config = readFileSync(
      new URL(`../apps/${service}/src/config.ts`, import.meta.url),
      'utf8',
    );
    const read = [...config.matchAll(/^ {4}([A-Z][A-Z0-9_]+):/gm)].map(
      (m) => m[1],
    );
    assert.ok(read.length > 5, `${service}: no settings found`);
    const passed = passedTo(service);
    // Limits and money tunables take the code's defaults (owner, 14 Nov 2026, #216).
    const missing = read.filter(
      (key) =>
        !passed.has(key) &&
        !testOnly.has(key) &&
        !key.startsWith('RATE_LIMIT_') &&
        key !== 'PARTNER_QUOTE_CACHE_SECONDS' &&
        key !== 'BACHS_RESERVE_ALERT_MINOR',
    );
    assert.deepEqual(missing, [], `${service} settings missing from compose`);
  }
});

test('the staging api keeps its own internet route, independent of the edge network', () => {
  const compose = readFileSync(
    new URL('../deploy/compose.staging.yml', import.meta.url),
    'utf8',
  );
  const api = compose.split(/^ {2}api:\n/m)[1]?.split(/^ {2}[a-z]/m)[0] ?? '';
  assert.match(api, /^ {6}egress:/m);
  assert.match(api, /^ {6}internal:/m);
  assert.match(api, /^ {6}edge-staging: \{ aliases: \[staging-api\] \}/m);
});

test('the staging worker can reach the payment provider (it asks Bachs whether tips were paid)', () => {
  const compose = readFileSync(
    new URL('../deploy/compose.staging.yml', import.meta.url),
    'utf8',
  );
  const worker =
    compose.split(/^ {2}worker:\n/m)[1]?.split(/^ {2}[a-z]/m)[0] ?? '';
  // `internal` has no internet route. Without `egress` every status check times out, the error is
  // only counted, and paid tips stay "Still checking" until someone looks.
  const networks = /^ {4}networks: \[([^\]]*)\]/m.exec(worker)?.[1] ?? '';
  assert.match(networks, /\begress\b/);
  assert.match(networks, /\binternal\b/);
});

// --- The website on this server (self-hosted since Vercel paused it, 26 Nov 2026) ---
const W1 = 'aaaaaaa1';
const W2 = 'bbbbbbb2';
const callLines = (read) => read('calls.log').split('\n').filter(Boolean);

test('a version with the website needs its web image too, or nothing runs', () => {
  const { run, read, ship } = stage();
  ship(W1, undefined, { web: true, webImage: false });
  const result = run('deploy.sh', [W1]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tipme-web-staging:aaaaaaa1/);
  assert.equal(
    callLines(read).filter((l) => / up | run --rm /.test(l)).length,
    0,
    'nothing was started, backed up or migrated',
  );
});

test('the switch starts the website with the API, and the deploy waits until it serves this version', () => {
  const { run, read, ship } = stage();
  ship(W1, undefined, { web: true });
  const result = run('deploy.sh', [W1]);
  assert.equal(result.status, 0, result.stderr);
  const calls = callLines(read);
  const up = calls.findIndex((l) =>
    /up -d --remove-orphans api .*\bweb\b/.test(l),
  );
  const asked = calls.findIndex((l) =>
    /^curl https:\/\/staging\.example\.test\/api\/version$/.test(l),
  );
  assert.ok(up >= 0 && up < asked, calls.join('\n'));
  assert.equal(read('web-running').trim(), W1);
  assert.equal(read('releases/current').trim(), W1);
});

test('a website that does not serve the new version fails the deploy and puts the previous one back', () => {
  const { run, read, ship } = stage();
  ship(W1, undefined, { web: true });
  ship(W2, undefined, { web: true });
  assert.equal(run('deploy.sh', [W1]).status, 0);
  const result = run('deploy.sh', [W2], { FAKE_WEB_BROKEN: W2 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bbbbbbb2 did not become healthy/);
  assert.equal(read('releases/current').trim(), W1);
  assert.equal(read('web-running').trim(), W1);
  assert.equal(read('running').trim(), W1);
});

test('a version from before the website deploys and rolls back as before (no web check)', () => {
  const { run, read, ship } = stage();
  ship(W1);
  ship(W2);
  assert.equal(run('deploy.sh', [W1]).status, 0);
  assert.equal(run('deploy.sh', [W2]).status, 0);
  assert.equal(run('rollback.sh').status, 0);
  assert.ok(callLines(read).every((l) => !/api\/version|\bweb\b/.test(l)));
});

test('rolling back from a version with the website to one from before it is refused', () => {
  const { run, read, ship } = stage();
  ship(W1);
  ship(W2, undefined, { web: true });
  assert.equal(run('deploy.sh', [W1]).status, 0);
  assert.equal(run('deploy.sh', [W2]).status, 0);
  const before = callLines(read).length;
  const result = run('rollback.sh');
  assert.equal(result.status, 2);
  assert.match(
    result.stderr,
    /aaaaaaa1 is from before the website ran on this server/,
  );
  assert.equal(read('releases/current').trim(), W2);
  assert.equal(
    callLines(read)
      .slice(before)
      .filter((l) => / up /.test(l)).length,
    0,
  );
});

test('rolling back between versions with the website brings the website back too', () => {
  const { run, read, ship } = stage();
  ship(W1, undefined, { web: true });
  ship(W2, undefined, { web: true });
  assert.equal(run('deploy.sh', [W1]).status, 0);
  assert.equal(run('deploy.sh', [W2]).status, 0);
  const result = run('rollback.sh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read('web-running').trim(), W1);
  assert.equal(read('releases/current').trim(), W1);
});

test('pruning an old version removes its web image with its app image', () => {
  const { run, read, ship } = stage();
  const versions = ['a0000001', 'a0000002', 'a0000003'];
  for (const v of versions) ship(v, undefined, { web: true });
  for (const v of versions)
    assert.equal(run('deploy.sh', [v], { KEEP_VERSIONS: '1' }).status, 0);
  const images = read('images');
  assert.doesNotMatch(images, /tipme-web-staging:a0000001/);
  assert.doesNotMatch(images, /tipme-app:a0000001/);
  assert.match(images, /tipme-web-staging:a0000003/);
});
