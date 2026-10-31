import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  PRODUCTION_ENV,
  stageProduction,
} from './test-support/fake-server.mjs';

// deploy-production.sh and rollback-production.sh (blue/green), on the fake server: the idle
// colour starts on the new version, the edge sends it traffic once it is ready, and only then does
// the old colour stop. The other colour keeps serving whatever goes wrong.
const A = 'aaaaaaa1';
const B = 'bbbbbbb2';
const C = 'ccccccc3';

const lines = (read) => read('calls.log').split('\n').filter(Boolean);
const composeCalls = (read) =>
  lines(read).filter((line) => line.startsWith('docker compose '));
const indexOf = (calls, pattern) => calls.findIndex((l) => pattern.test(l));

test('first deploy starts blue ×3, stops nothing, records active=blue', () => {
  const { run, read, ship, running, colours } = stageProduction();
  ship(A);
  const result = run('deploy-production.sh', [A]);
  assert.equal(result.status, 0, result.stderr);
  const calls = composeCalls(read);
  assert.ok(
    calls.some((l) =>
      /up -d --wait --no-deps api-blue \|.* blue=aaaaaaa1 /.test(l),
    ),
    calls.join('\n'),
  );
  assert.equal(indexOf(calls, / stop /), -1, 'nothing to stop');
  assert.equal(indexOf(calls, /api-green \|/), -1, 'green is never touched');
  assert.equal(running('api-blue'), A);
  assert.equal(running('api-green'), '');
  assert.deepEqual(colours(), { blue: A, active: 'blue' });
  assert.equal(read('releases/current').trim(), A);
  assert.equal(read('releases/deployed').trim(), A);
  assert.ok(
    calls.every((l) => l.includes('releases/aaaaaaa1/compose.production.yml')),
  );
});

test('roles, then migrations with the backup flag and database named, then roles, all before any colour starts', () => {
  const { run, read, ship } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  const before = composeCalls(read).length;
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  const calls = composeCalls(read).slice(before);
  const roles = calls.flatMap((l, i) =>
    / run --rm db-roles /.test(l) ? [i] : [],
  );
  const migrate = indexOf(calls, / run --rm migrate .*confirm=tipme backup=1$/);
  const redis = indexOf(calls, / up .*redis \|/);
  const colour = indexOf(calls, / up .*api-(blue|green) \|/);
  assert.equal(roles.length, 2, calls.join('\n'));
  assert.ok(
    redis < roles[0] &&
      roles[0] < migrate &&
      migrate < roles[1] &&
      roles[1] < colour,
    calls.join('\n'),
  );
  assert.ok(calls.slice(0, colour).every((l) => /version=bbbbbbb2 /.test(l)));
  // Only the migrate call is told the backup is done.
  assert.ok(
    calls
      .filter((l) => / backup=1$/.test(l))
      .every((l) => / run --rm migrate /.test(l)),
  );
});

test('the idle colour starts on the new version, the old colour stops only after it is healthy', () => {
  const { run, read, ship, running, colours } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  const before = lines(read).length;
  const result = run('deploy-production.sh', [B]);
  assert.equal(result.status, 0, result.stderr);
  const calls = lines(read).slice(before);
  const start = indexOf(calls, /up -d --wait --no-deps api-green \|/);
  const seen = indexOf(calls, /^curl .*\/health\/release -> bbbbbbb2$/);
  const stop = indexOf(calls, /compose .* stop -t 20 api-blue \|/);
  assert.ok(start >= 0 && start < seen && seen < stop, calls.join('\n'));
  // The edge still sent some polls to blue (round-robin) before green answered.
  assert.ok(calls.slice(start, seen).some((l) => / -> aaaaaaa1$/.test(l)));
  assert.match(calls[start], / blue=aaaaaaa1 green=bbbbbbb2 /);
  assert.equal(running('api-blue'), '');
  assert.equal(running('api-green'), B);
  assert.deepEqual(colours(), { blue: A, green: B, active: 'green' });
  assert.equal(read('releases/current').trim(), B);
});

test('the health wait asks the public API host over https, or HEALTH_BASE_URL when set', () => {
  const first = stageProduction();
  first.ship(A);
  assert.equal(first.run('deploy-production.sh', [A]).status, 0);
  const curls = lines(first.read).filter((l) => l.startsWith('curl '));
  assert.ok(curls.length > 0);
  assert.ok(
    curls.every((l) =>
      /^curl https:\/\/api\.production\.example\.test\/health\/(ready|release) /.test(
        l,
      ),
    ),
    curls.join('\n'),
  );
  const local = stageProduction({
    env: { HEALTH_BASE_URL: 'http://127.0.0.1:8080' },
  });
  local.ship(A);
  assert.equal(local.run('deploy-production.sh', [A]).status, 0);
  const localCurls = lines(local.read).filter((l) => l.startsWith('curl '));
  assert.ok(
    localCurls.every((l) =>
      /^curl http:\/\/127\.0\.0\.1:8080\/health\//.test(l),
    ),
  );
});

test('workers are replaced one at a time after the switch', () => {
  const { run, read, ship, running } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(running('worker-a'), A);
  const before = composeCalls(read).length;
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  const calls = composeCalls(read).slice(before);
  const stop = indexOf(calls, / stop -t 20 api-blue /);
  const a = indexOf(
    calls,
    /up -d --wait --no-deps worker-a \|.*version=bbbbbbb2 /,
  );
  const b = indexOf(
    calls,
    /up -d --wait --no-deps worker-b \|.*version=bbbbbbb2 /,
  );
  assert.ok(stop >= 0 && stop < a && a < b, calls.join('\n'));
  // Never both in one call (that would stop both at once).
  assert.equal(indexOf(calls, /worker-a.*worker-b|worker-b.*worker-a/), -1);
  assert.equal(running('worker-a'), B);
  assert.equal(running('worker-b'), B);
});

test('every compose call carries the home, all three versions and the env file, with the live colour on its real version', () => {
  const { run, read, ship, home } = stageProduction();
  ship(A);
  ship(B);
  ship(C);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  assert.equal(run('deploy-production.sh', [C], { FAKE_BROKEN: C }).status, 1);
  assert.equal(run('rollback-production.sh').status, 0);
  const calls = composeCalls(read);
  assert.ok(calls.length > 20);
  for (const line of calls) {
    assert.ok(
      line.includes(`--env-file ${join(home, 'production.env')} `),
      line,
    );
    assert.ok(line.includes(` home=${home} `), line);
    const versions = / version=(\S+) blue=(\S+) green=(\S+) /.exec(line);
    assert.ok(versions, line);
    for (const v of versions.slice(1))
      assert.ok(v !== 'UNSET' && v !== '', `a version is missing: ${line}`);
  }
  // While B serves from green, every call (deploying C, then rolling back) keeps green=B.
  const secondDone = calls.findLastIndex((l) =>
    / up .*worker-b .*version=bbbbbbb2 /.test(l),
  );
  const firstC = indexOf(calls, /version=ccccccc3 /);
  const rollbackStart = indexOf(
    calls,
    /up -d --wait --no-deps api-blue \| version=aaaaaaa1 blue=aaaaaaa1 green=bbbbbbb2 /,
  );
  assert.ok(secondDone < firstC && firstC < rollbackStart, calls.join('\n'));
  for (const line of calls.slice(secondDone + 1, rollbackStart + 1))
    assert.match(line, / green=bbbbbbb2 /, line);
  // During the first deploy blue is the only colour that ever ran.
  const firstDone = indexOf(calls, / up .*worker-b .*version=aaaaaaa1 /);
  for (const line of calls.slice(0, firstDone + 1))
    assert.match(line, / green=none /, line);
});

test('an unhealthy new colour leaves the old one serving and stops the new one', () => {
  const { run, read, ship, running, colours } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  const before = composeCalls(read).length;
  const result = run('deploy-production.sh', [B], { FAKE_BROKEN: B });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /bbbbbbb2 did not become healthy/);
  const calls = composeCalls(read).slice(before);
  assert.ok(indexOf(calls, / stop -t 20 api-green \|/) >= 0, calls.join('\n'));
  assert.equal(indexOf(calls, / stop .*api-blue/), -1, 'blue keeps serving');
  assert.equal(indexOf(calls, /worker-/), -1, 'workers are not touched');
  assert.equal(running('api-blue'), A);
  assert.equal(running('api-green'), '');
  assert.equal(running('worker-a'), A);
  assert.deepEqual(colours(), { blue: A, active: 'blue' });
  assert.equal(read('releases/current').trim(), A);
  assert.equal(read('releases/deployed').trim(), A);
});

test('a new colour that fails to start is stopped too, and the old one keeps serving', () => {
  const { run, read, ship, running, colours, exists } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  const result = run('deploy-production.sh', [B], { FAKE_UP_FAILS: B });
  assert.equal(result.status, 1);
  assert.ok(lines(read).some((l) => / stop -t 20 api-green \|/.test(l)));
  assert.equal(running('api-blue'), A);
  assert.deepEqual(colours(), { blue: A, active: 'blue' });
  assert.equal(exists('releases/.deploy.lock'), false, 'the lock is released');
});

test('a failed migration stops the deploy before any colour changes', () => {
  const { run, read, ship, running, colours } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  const before = composeCalls(read).length;
  const result = run('deploy-production.sh', [B], { FAKE_MIGRATE_FAILS: '1' });
  assert.notEqual(result.status, 0);
  const calls = composeCalls(read).slice(before);
  assert.equal(
    indexOf(calls, /api-(blue|green)|worker-/),
    -1,
    calls.join('\n'),
  );
  assert.equal(running('api-blue'), A);
  assert.deepEqual(colours(), { blue: A, active: 'blue' });
});

test('rollback starts the previous version on the idle colour and switches back', () => {
  const { run, read, ship, running, colours } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  const before = lines(read).length;
  const result = run('rollback-production.sh');
  assert.equal(result.status, 0, result.stderr);
  const calls = lines(read).slice(before);
  const start = indexOf(
    calls,
    /up -d --wait --no-deps api-blue \|.* blue=aaaaaaa1 green=bbbbbbb2 /,
  );
  const seen = indexOf(calls, /^curl .*\/health\/release -> aaaaaaa1$/);
  const stop = indexOf(calls, / stop -t 20 api-green \|/);
  const a = indexOf(
    calls,
    /up -d --wait --no-deps worker-a \|.*version=aaaaaaa1 /,
  );
  const b = indexOf(
    calls,
    /up -d --wait --no-deps worker-b \|.*version=aaaaaaa1 /,
  );
  assert.ok(
    start >= 0 && start < seen && seen < stop && stop < a && a < b,
    calls.join('\n'),
  );
  assert.equal(
    indexOf(calls, /run --rm (migrate|db-roles)/),
    -1,
    'no migrations, no roles',
  );
  assert.equal(running('api-blue'), A);
  assert.equal(running('api-green'), '');
  assert.equal(running('worker-b'), A);
  assert.deepEqual(colours(), { blue: A, green: B, active: 'blue' });
  assert.equal(read('releases/current').trim(), A);
  // Rolling back again goes further back, never forward to B.
  const again = run('rollback-production.sh');
  assert.equal(again.status, 2);
  assert.equal(running('api-blue'), A);
});

test('an unhealthy rollback target is stopped and the current colour keeps serving', () => {
  const { run, ship, running, colours } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  const result = run('rollback-production.sh', [], { FAKE_BROKEN: A });
  assert.equal(result.status, 1);
  assert.equal(running('api-green'), B);
  assert.equal(running('api-blue'), '');
  assert.deepEqual(colours(), { blue: A, green: B, active: 'green' });
});

test('rollback to a given version needs one that was shipped and deployed before the current one', () => {
  const { run, read, ship, running } = stageProduction();
  ship(A);
  ship(B);
  ship(C);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  const before = composeCalls(read).length;
  const later = run('rollback-production.sh', [C]);
  assert.equal(later.status, 2);
  assert.match(later.stderr, /not deployed before/);
  const unknown = run('rollback-production.sh', ['ddddddd4']);
  assert.equal(unknown.status, 2);
  assert.equal(composeCalls(read).length, before, 'nothing ran');
  const ok = run('rollback-production.sh', [A]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(running('api-blue'), A);
});

test('a second deploy while one runs is refused', () => {
  const { run, read, ship, home, exists } = stageProduction();
  ship(A);
  mkdirSync(join(home, 'releases', '.deploy.lock'), { recursive: true });
  for (const [script, args] of [
    ['deploy-production.sh', [A]],
    ['rollback-production.sh', []],
  ]) {
    const result = run(script, args);
    assert.equal(result.status, 2, script);
    assert.match(result.stderr, /another deploy or rollback is running/i);
    assert.match(
      result.stderr,
      /\.deploy\.lock/,
      'says how to clear a stale lock',
    );
  }
  assert.equal(composeCalls(read).length, 0, 'nothing ran');
  assert.equal(
    exists('releases/.deploy.lock'),
    true,
    'the holder keeps its lock',
  );
});

test('the lock is released after a deploy, so the next one can run', () => {
  const { run, ship, exists } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(exists('releases/.deploy.lock'), false);
  assert.equal(run('deploy-production.sh', [B], { FAKE_BROKEN: B }).status, 1);
  assert.equal(exists('releases/.deploy.lock'), false);
  assert.equal(run('deploy-production.sh', [B]).status, 0);
});

test('a version that was never shipped is refused before anything runs', () => {
  const { run, read } = stageProduction();
  const result = run('deploy-production.sh', ['ddddddd4']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /not loaded|not shipped/);
  assert.equal(read('calls.log').includes('compose'), false);
});

test('redis is never restarted by a deploy', () => {
  const { run, read, ship } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  assert.equal(run('rollback-production.sh').status, 0);
  const calls = composeCalls(read);
  const redisUps = calls.filter((l) => / up .*\bredis \|/.test(l));
  assert.equal(redisUps.length, 2, 'started (if absent) on each deploy');
  // --no-recreate: a changed Compose file never recreates the live Redis.
  for (const line of redisUps)
    assert.match(line, / up -d --wait --no-recreate redis \|/);
  assert.equal(indexOf(calls, / (restart|stop|down|rm)\b.*redis/), -1);
  assert.equal(
    indexOf(calls, / up (?!.*--no-(deps|recreate))/),
    -1,
    'every up names its service',
  );
  assert.equal(indexOf(calls, / down\b/), -1);
});

test('production never touches the staging edge network', () => {
  const { run, read, ship } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(run('rollback-production.sh', [A]).status, 2);
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  assert.equal(run('rollback-production.sh').status, 0);
  const all = lines(read);
  assert.equal(
    indexOf(all, /network connect|edge-staging/),
    -1,
    all.join('\n'),
  );
});

test('pruning keeps both colours and the current version', () => {
  const { run, read, ship, exists } = stageProduction();
  const versions = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map(
    (v) => `${v}00000`,
  );
  for (const version of versions) {
    ship(version);
    assert.equal(
      run('deploy-production.sh', [version], { KEEP_VERSIONS: '1' }).status,
      0,
    );
  }
  // KEEP_VERSIONS=1 keeps only the newest by count; the other colour (a6) stays as well.
  assert.deepEqual(read('images').trim().split('\n'), [
    'tipme-app:a600000',
    'tipme-app:a700000',
  ]);
  assert.equal(exists('releases/a600000/compose.production.yml'), true);
  assert.equal(exists('releases/a500000'), false);
});

test('production preflight refuses a missing CA file, database URL, confirm name or role password, naming settings only', () => {
  const cases = [
    [{ caFile: false }, /db-ca\.pem/],
    [{ env: { DATABASE_URL: '' } }, /DATABASE_URL is required/],
    [
      { env: { MIGRATION_DATABASE_URL: undefined } },
      /MIGRATION_DATABASE_URL is required/,
    ],
    [{ env: { DATABASE_ADMIN_URL: '' } }, /DATABASE_ADMIN_URL is required/],
    [
      { env: { MIGRATE_CONFIRM_DATABASE: '' } },
      /MIGRATE_CONFIRM_DATABASE is required/,
    ],
    [
      { env: { POSTGRES_BACKUP_PASSWORD: undefined } },
      /POSTGRES_BACKUP_PASSWORD is required/,
    ],
    [
      { env: { POSTGRES_MIGRATOR_PASSWORD: 'ab/cd+e=' } },
      /POSTGRES_MIGRATOR_PASSWORD must be 16\+/,
    ],
    [
      {
        env: {
          POSTGRES_BACKUP_PASSWORD: PRODUCTION_ENV.POSTGRES_RUNTIME_PASSWORD,
        },
      },
      /role passwords must be unique/,
    ],
  ];
  for (const [options, message] of cases) {
    const { run, read, ship } = stageProduction(options);
    ship(A);
    const result = run('deploy-production.sh', [A]);
    assert.equal(result.status, 2, JSON.stringify(options));
    assert.match(result.stderr, message);
    for (const value of Object.values(PRODUCTION_ENV).filter(
      (v) => v.length > 5,
    ))
      assert.ok(!result.stderr.includes(value), 'a setting value was printed');
    assert.equal(composeCalls(read).length, 0, 'nothing ran');
  }
});

test('a missing edge-production network is refused before anything runs', () => {
  const { run, read, ship } = stageProduction();
  ship(A);
  const result = run('deploy-production.sh', [A], { FAKE_NO_EDGE: '1' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /edge-production/);
  assert.equal(composeCalls(read).length, 0);
});

test('the staging scripts stay on staging even when TIPME_STACK says production', () => {
  // deploy.sh/rollback.sh are staging's; a stray TIPME_STACK in the environment must not point
  // them at the production files.
  const { run, read, ship, home } = stageProduction();
  ship(A);
  const result = run('deploy.sh', [A]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /staging\.env/);
  assert.equal(read('calls.log').includes(join(home, 'production.env')), false);
});

test('compose.sh on production runs compose for the current version with both colours', () => {
  const { run, read, ship } = stageProduction();
  ship(A);
  ship(B);
  assert.equal(run('deploy-production.sh', [A]).status, 0);
  assert.equal(run('deploy-production.sh', [B]).status, 0);
  const result = run('compose.sh', ['ps']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    composeCalls(read).at(-1),
    /releases\/bbbbbbb2\/compose\.production\.yml .* ps \| version=bbbbbbb2 blue=aaaaaaa1 green=bbbbbbb2 /,
  );
});
