import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// The real server scripts (deploy/scripts), with docker, git, curl and sleep replaced by
// stand-ins that record what they were asked and simulate a healthy or broken version.
// Images are built and shipped by GitHub Actions: the server never builds or fetches code.
const SCRIPTS = resolve('deploy/scripts');

function stage({ password = 'hexpassword0123456789abcdef' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tipme-deploy-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(home, 'staging.env'),
    `API_HOST=api.staging.example.test\nPOSTGRES_PASSWORD=${password}\n`,
  );
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // docker: log every call; `compose ... up ... api` makes TIPME_VERSION the running version;
  // `image inspect/rm` use a list of loaded images.
  fake(
    'docker',
    `echo "docker $* | version=$TIPME_VERSION confirm=$MIGRATE_CONFIRM_DATABASE backup=$MIGRATE_BACKUP_DONE" >> "$FAKE_LOG"
if [[ "$1 $2" == "image inspect" ]]; then grep -qx "$3" "$FAKE_IMAGES" 2>/dev/null; exit $?; fi
if [[ "$1 $2" == "image rm" ]]; then grep -vx "$3" "$FAKE_IMAGES" > "$FAKE_IMAGES.tmp"; mv "$FAKE_IMAGES.tmp" "$FAKE_IMAGES"; exit 0; fi
if [[ " $* " == *" up "* && " $* " == *" api "* ]]; then echo "$TIPME_VERSION" > "$FAKE_RUNNING"; fi
exit 0`,
  );
  fake('git', 'echo "git $*" >> "$FAKE_LOG"; exit 1');
  // lib.sh checks that backups are owned by the image user (uid 1000). The temp dir is not.
  fake(
    'stat',
    `if [[ "$1" == "-c" && "$2" == "%u" ]]; then echo "\${FAKE_STAT_UID:-1000}"; exit 0; fi
echo "unexpected stat $*" >&2
exit 1`,
  );
  // curl: healthy unless the running version is the broken one.
  fake(
    'curl',
    `running=$(cat "$FAKE_RUNNING" 2>/dev/null)
if [[ -n "$FAKE_BROKEN" && "$running" == "$FAKE_BROKEN" ]]; then exit 22; fi
case "$*" in *release*) echo "{\\"data\\":{\\"version\\":\\"$running\\"}}" ;; esac
exit 0`,
  );
  fake('sleep', 'exit 0');
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    TIPME_HOME: home,
    FAKE_LOG: join(home, 'calls.log'),
    FAKE_RUNNING: join(home, 'running'),
    FAKE_IMAGES: join(home, 'images'),
    HEALTH_TRIES: '2',
  };
  /** What GitHub Actions does before deploying: load the image and copy that version's files. */
  const ship = (version) => {
    mkdirSync(join(home, 'releases', version), { recursive: true });
    writeFileSync(
      join(home, 'releases', version, 'compose.staging.yml'),
      'services: {}\n',
    );
    writeFileSync(env.FAKE_IMAGES, `tipme-app:${version}\n`, { flag: 'a' });
  };
  const run = (script, args = [], extra = {}) =>
    spawnSync('bash', [join(SCRIPTS, script), ...args], {
      env: { ...env, ...extra },
      encoding: 'utf8',
    });
  const read = (file) => {
    try {
      return readFileSync(join(home, file), 'utf8');
    } catch {
      return '';
    }
  };
  const exists = (file) => existsSync(join(home, file));
  return { run, read, ship, exists, home };
}

test('a deploy of a shipped image backs up, migrates with the database named, switches and records it, without git or a build', () => {
  const { run, read, ship } = stage();
  ship('aaaaaaa1');
  const result = run('deploy.sh', ['aaaaaaa1']);
  assert.equal(result.status, 0, result.stderr);
  const calls = read('calls.log').split('\n');
  const at = (pattern) => calls.findIndex((line) => pattern.test(line));
  const backup = at(/run --rm backup/);
  const migrate = at(/run --rm migrate.*confirm=tipme backup=1/);
  const up = at(/up -d --remove-orphans api/);
  assert.ok(backup >= 0 && backup < migrate && migrate < up, calls.join('\n'));
  assert.ok(
    calls.some((l) => l.includes('releases/aaaaaaa1/compose.staging.yml')),
    'uses that version’s files',
  );
  assert.equal(at(/docker build/), -1, 'the server never builds');
  assert.equal(at(/^git /), -1, 'the server never fetches code');
  assert.equal(read('releases/current').trim(), 'aaaaaaa1');
  assert.equal(read('running').trim(), 'aaaaaaa1');
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
