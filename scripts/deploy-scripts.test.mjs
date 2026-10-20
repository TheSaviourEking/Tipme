import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// The real deploy/rollback scripts (PR-010 final review I-3/I-4), with docker, git, curl and sleep
// replaced by stand-ins that record what they were asked and simulate a healthy or broken version.
const SCRIPTS = resolve('deploy/scripts');

function stage({ password = 'hexpassword0123456789abcdef' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tipme-deploy-'));
  const bin = join(home, 'bin');
  mkdirSync(join(home, 'app/deploy'), { recursive: true });
  mkdirSync(bin);
  writeFileSync(
    join(home, 'staging.env'),
    `API_HOST=api.staging.example.test\nPOSTGRES_PASSWORD=${password}\n`,
  );
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // docker: log every call; `compose ... up` makes TIPME_VERSION the running version.
  fake(
    'docker',
    `echo "docker $* | version=$TIPME_VERSION confirm=$MIGRATE_CONFIRM_DATABASE backup=$MIGRATE_BACKUP_DONE" >> "$FAKE_LOG"
if [[ " $* " == *" up "* && " $* " == *" api "* ]]; then echo "$TIPME_VERSION" > "$FAKE_RUNNING"; fi
exit 0`,
  );
  // git: checkout records the target; rev-parse returns it.
  fake(
    'git',
    `echo "git $*" >> "$FAKE_LOG"
case "$*" in
  *checkout*) echo "\${@: -1}" > "$FAKE_HEAD" ;;
  *rev-parse*) cat "$FAKE_HEAD" ;;
esac`,
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
    FAKE_HEAD: join(home, 'head'),
    HEALTH_TRIES: '2',
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
  return { run, read };
}

test('a deploy backs up, migrates with the database named, then switches and records the version', () => {
  const { run, read } = stage();
  const result = run('deploy.sh', ['aaaaaaa1']);
  assert.equal(result.status, 0, result.stderr);
  const calls = read('calls.log').split('\n');
  const at = (pattern) => calls.findIndex((line) => pattern.test(line));
  const build = at(/docker build/);
  const backup = at(/run --rm backup/);
  const migrate = at(/run --rm migrate.*confirm=tipme backup=1/);
  const up = at(/up -d --remove-orphans api/);
  assert.ok(
    build >= 0 && build < backup && backup < migrate && migrate < up,
    calls.join('\n'),
  );
  assert.equal(read('releases/current').trim(), 'aaaaaaa1');
  assert.equal(read('running').trim(), 'aaaaaaa1');
});

test('fix (final review I-3): rolling back twice never goes forward to the version just backed out', () => {
  const { run, read } = stage();
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
  const { run, read } = stage();
  assert.equal(run('deploy.sh', ['aaaaaaa1']).status, 0);
  const broken = run('deploy.sh', ['ccccccc3'], { FAKE_BROKEN: 'ccccccc3' });
  assert.equal(broken.status, 1);
  assert.equal(read('running').trim(), 'aaaaaaa1');
  assert.equal(read('releases/current').trim(), 'aaaaaaa1');
});

test('fix (final review I-2): a database password that would break the connection address is refused before anything runs', () => {
  const { run, read } = stage({ password: 'ab/cd+e=' });
  const result = run('deploy.sh', ['aaaaaaa1']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /POSTGRES_PASSWORD/);
  assert.equal(
    read('calls.log'),
    '',
    'nothing was built, backed up or migrated',
  );
});
