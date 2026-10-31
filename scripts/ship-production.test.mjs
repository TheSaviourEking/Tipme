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

// scripts/ship-production.sh with a stand-in `ssh` (runs the remote command locally, in a fake
// server) and `docker` (save prints bytes, load records them, run reports the Caddyfile verdict).
function stage({ caddyfileValid = true, reloadFails = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tipme-ship-prod-'));
  const production = join(root, 'srv-tipme-production');
  const edge = join(root, 'srv-tipme-edge');
  const bin = join(root, 'bin');
  mkdirSync(production, { recursive: true });
  mkdirSync(edge, { recursive: true });
  mkdirSync(bin);
  // The edge as the server already runs it: its own compose file and Caddyfile.
  writeFileSync(join(edge, 'compose.edge.yml'), 'old compose\n');
  writeFileSync(join(edge, 'Caddyfile'), 'old caddyfile\n');
  const fake = (name, body) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // The remote command mentions the real /srv paths; point them at the fake server.
  fake(
    'ssh',
    `while [[ "$1" == -* ]]; do [[ "$1" == "-i" || "$1" == "-o" ]] && shift; shift; done
target=$1; shift
echo "ssh $target" >> "$FAKE_LOG"
cmd="$*"; cmd=\${cmd//\\/srv\\/tipme-edge/$FAKE_EDGE}; cmd=\${cmd//\\/srv\\/tipme-production/$FAKE_PRODUCTION}
bash -c "$cmd"`,
  );
  fake(
    'docker',
    `case "$1" in
  save) echo "IMAGE-BYTES-$2" ;;
  load) cat > "$FAKE_PRODUCTION/loaded"; echo "Loaded image" ;;
  run) echo "docker $*" >> "$FAKE_LOG"; [[ "$FAKE_CADDY_VALID" == "1" ]] ;;
  compose) echo "docker $*" >> "$FAKE_LOG"; [[ "$FAKE_RELOAD_FAIL" != "1" ]] ;;
  *) echo "docker $*" >> "$FAKE_LOG" ;;
esac`,
  );
  const env = {
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_LOG: join(root, 'calls.log'),
    FAKE_PRODUCTION: production,
    FAKE_EDGE: edge,
    FAKE_RELOAD_FAIL: reloadFails ? '1' : '0',
    FAKE_CADDY_VALID: caddyfileValid ? '1' : '0',
    PRODUCTION_SSH: 'deploy@production.example.test',
    PRODUCTION_HOME: production,
    PRODUCTION_EDGE_HOME: edge,
    // Stop before the real deploy script runs: it is tested on its own.
    PRODUCTION_SKIP_DEPLOY: '1',
  };
  // A fake deploy script is not needed: nothing is shipped when the edge step fails.
  const run = (args) =>
    spawnSync('bash', [resolve('scripts/ship-production.sh'), ...args], {
      env,
      encoding: 'utf8',
    });
  const log = () =>
    existsSync(env.FAKE_LOG) ? readFileSync(env.FAKE_LOG, 'utf8') : '';
  return { run, production, edge, log };
}

test('ship-production copies only production files to the production home', () => {
  const { run, production } = stage();
  const result = run(['abcdef123456']);
  assert.equal(result.status, 0, result.stderr);
  const release = join(production, 'releases/abcdef123456');
  for (const file of [
    'compose.production.yml',
    'scripts/deploy-production.sh',
    'scripts/rollback-production.sh',
    'scripts/lib.sh',
  ])
    assert.ok(existsSync(join(release, file)), file);
  for (const file of ['compose.staging.yml', 'postgres', 'edge', 'local'])
    assert.equal(existsSync(join(release, file)), false, `${file} never ships`);
  assert.match(
    readFileSync(join(production, 'loaded'), 'utf8'),
    /IMAGE-BYTES-tipme-app:abcdef123456/,
  );
});

test('a valid Caddyfile is validated with the edge env, moved into place and reloaded', () => {
  const { run, edge, log } = stage();
  const result = run(['abcdef123456']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(join(edge, 'Caddyfile'), 'utf8'), /reverse_proxy/);
  const calls = log();
  assert.match(
    calls,
    /docker run --rm --env-file .*edge\.env .*caddy:2\.10\.2-alpine caddy validate/,
  );
  assert.match(
    calls,
    /docker compose -p tipme-edge -f .*compose\.edge\.yml exec -T caddy caddy reload/,
  );
  assert.ok(calls.indexOf('caddy validate') < calls.indexOf('caddy reload'));
});

test('a changed compose.edge.yml is not applied; the ship says a manual up -d is needed', () => {
  const { run, edge } = stage();
  const result = run(['abcdef123456']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /up -d/);
  assert.equal(
    readFileSync(join(edge, 'compose.edge.yml'), 'utf8'),
    'old compose\n',
  );
});

test('an invalid Caddyfile stops the ship before anything is deployed', () => {
  const { run, edge, production, log } = stage({ caddyfileValid: false });
  const result = run(['abcdef123456']);
  assert.notEqual(result.status, 0);
  assert.equal(
    readFileSync(join(edge, 'Caddyfile'), 'utf8'),
    'old caddyfile\n',
  );
  assert.doesNotMatch(log(), /caddy reload/);
  assert.equal(existsSync(join(production, 'releases')), false);
  assert.equal(existsSync(join(production, 'loaded')), false);
});

test('shipping refuses anything that is not a version', () => {
  const { run } = stage();
  for (const bad of [[], ['main'], ['abc; rm -rf /']])
    assert.equal(run(bad).status, 2, JSON.stringify(bad));
});

test('a failed reload puts the previous Caddyfile back and stops before production', () => {
  const { run, edge, production, log } = stage({ reloadFails: true });
  const result = run(['abcdef123456']);
  assert.notEqual(result.status, 0);
  assert.equal(
    readFileSync(join(edge, 'Caddyfile'), 'utf8'),
    'old caddyfile\n',
  );
  assert.match(result.stderr + result.stdout, /reload failed/i);
  // Reloaded once for the new file, once more for the restored one.
  assert.equal((log().match(/caddy reload/g) ?? []).length, 2);
  assert.equal(existsSync(join(production, 'releases')), false);
  assert.equal(existsSync(join(production, 'loaded')), false);
});
