import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// scripts/ship-staging.sh with a stand-in `ssh` (runs the remote command locally, in a fake
// server home) and `docker` (save prints bytes, load records them).
function stage() {
  const root = mkdtempSync(join(tmpdir(), 'tipme-ship-'));
  const server = join(root, 'srv-tipme');
  const bin = join(root, 'bin');
  mkdirSync(server, { recursive: true });
  mkdirSync(bin);
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // ssh [options] <target> <command>: run the command locally with the fake server home.
  fake(
    'ssh',
    `while [[ "$1" == -* ]]; do [[ "$1" == "-i" || "$1" == "-o" ]] && shift; shift; done
target=$1; shift
echo "ssh $target" >> "$FAKE_LOG"
TIPME_HOME="$FAKE_SERVER" FAKE_SERVER_RUN=1 bash -c "$*"`,
  );
  fake(
    'docker',
    `case "$1" in
  save) echo "IMAGE-BYTES-$2" ;;
  load) cat > "$FAKE_SERVER/loaded"; echo "Loaded image" ;;
  *) echo "docker $*" >> "$FAKE_LOG" ;;
esac`,
  );
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: join(root, 'calls.log'),
    FAKE_SERVER: server,
    STAGING_SSH: 'deploy@staging.example.test',
    STAGING_HOME: server,
    // Stop before the real deploy script runs: it is tested on its own.
    STAGING_SKIP_DEPLOY: '1',
  };
  const run = (args) =>
    spawnSync('bash', [resolve('scripts/ship-staging.sh'), ...args], {
      env,
      encoding: 'utf8',
    });
  return { run, server, root };
}

test('shipping copies that version’s deploy files and streams its image to the server', () => {
  const { run, server } = stage();
  const result = run(['abcdef123456']);
  assert.equal(result.status, 0, result.stderr);
  const release = join(server, 'releases/abcdef123456');
  for (const file of [
    'compose.staging.yml',
    'Caddyfile',
    'scripts/deploy.sh',
    'scripts/rollback.sh',
    'scripts/lib.sh',
    'scripts/pitr-drill.sh',
    'scripts/offsite-loop.sh',
    'postgres/pg_hba.conf',
    'postgres/archive-wal.sh',
  ])
    assert.ok(existsSync(join(release, file)), file);
  assert.equal(
    existsSync(join(release, 'local')),
    false,
    'local-only files never ship',
  );
  // The server side ran `gunzip | docker load`: it received the image itself.
  const loaded = readFileSync(join(server, 'loaded'), 'utf8');
  assert.match(loaded, /IMAGE-BYTES-tipme-app:abcdef123456/);
});

test('shipping refuses anything that is not a version', () => {
  const { run } = stage();
  for (const bad of [[], ['main'], ['abc; rm -rf /']])
    assert.equal(run(bad).status, 2, JSON.stringify(bad));
});
