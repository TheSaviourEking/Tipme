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
  save) shift; for image in "$@"; do echo "IMAGE-BYTES-$image"; done ;;
  load) cat >> "$FAKE_PRODUCTION/loaded"; echo "Loaded image" ;;
  image) echo "docker $*" >> "$FAKE_LOG"; [[ "$3" != "$FAKE_MISSING_IMAGE" ]] ;;
  run) echo "docker $*" >> "$FAKE_LOG"; [[ "$FAKE_CADDY_VALID" == "1" ]] ;;
  compose) echo "docker $*" >> "$FAKE_LOG"
    # The running edge's own environment (it read edge.env when it was created).
    if [[ " $* " == *" printenv "* ]]; then [[ " $FAKE_EDGE_ENV_MISSING " != *" \${!#} "* ]]; exit $?; fi
    [[ " $* " != *" reload "* || "$FAKE_RELOAD_FAIL" != "1" ]] ;;
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
  const run = (args, extra = {}) =>
    spawnSync('bash', [resolve('scripts/ship-production.sh'), ...args], {
      env: { ...env, ...extra },
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

test('the expected live state reaches the deploy, and an unclear one stops the ship', () => {
  const source = readFileSync(resolve('scripts/ship-production.sh'), 'utf8');
  assert.match(source, /deploy-production\.sh' '\$version' '\$expected_live'/);
  const bad = spawnSync(
    'bash',
    [resolve('scripts/ship-production.sh'), 'abcdef123456'],
    {
      env: { ...process.env, PRODUCTION_PAYMENTS_LIVE: 'yes' },
      encoding: 'utf8',
    },
  );
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /PRODUCTION_PAYMENTS_LIVE must be true or false/);
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

// The website runs on the server since Vercel paused it (26 Nov 2026): its production image ships
// in the same stream (the shared base layers travel once).
test('ship-production sends the production web image with the app image', () => {
  const { run, production } = stage();
  const result = run(['abcdef123456']);
  assert.equal(result.status, 0, result.stderr);
  const loaded = readFileSync(join(production, 'loaded'), 'utf8');
  assert.match(loaded, /IMAGE-BYTES-tipme-app:abcdef123456/);
  assert.match(loaded, /IMAGE-BYTES-tipme-web-production:abcdef123456/);
  assert.doesNotMatch(loaded, /tipme-web-staging/);
});

test('ship-production without the web image stops before the edge or production changes', () => {
  const { run, edge, production, log } = stage();
  const result = run(['abcdef123456'], {
    FAKE_MISSING_IMAGE: 'tipme-web-production:abcdef123456',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /tipme-web-production:abcdef123456/);
  assert.equal(
    readFileSync(join(edge, 'Caddyfile'), 'utf8'),
    'old caddyfile\n',
  );
  assert.doesNotMatch(log(), /ssh /);
  assert.equal(existsSync(join(production, 'releases')), false);
});

// Review C1: the edge reads edge.env only when its container is created. A Caddyfile naming a
// setting the running container lacks would reload with it empty, so the ship stops first and says
// to recreate the edge.
test('a Caddyfile naming a setting the running edge lacks stops the ship before anything changes', () => {
  const { run, edge, production, log } = stage();
  const result = run(['abcdef123456'], {
    FAKE_EDGE_ENV_MISSING: 'PRODUCTION_WEB_HOST STAGING_WEB_HOST',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PRODUCTION_WEB_HOST/);
  assert.match(result.stderr, /STAGING_WEB_HOST/);
  assert.match(result.stderr, /up -d/);
  assert.equal(
    readFileSync(join(edge, 'Caddyfile'), 'utf8'),
    'old caddyfile\n',
  );
  assert.doesNotMatch(log(), /caddy reload/);
  assert.equal(existsSync(join(production, 'releases')), false);
});

test('the ship asks the running edge for every setting the new Caddyfile reads', () => {
  const { run, log } = stage();
  assert.equal(run(['abcdef123456']).status, 0);
  const caddyfile = readFileSync(resolve('deploy/edge/Caddyfile'), 'utf8');
  const keys = new Set(
    [...caddyfile.matchAll(/\{\$([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
  );
  for (const key of keys)
    assert.match(log(), new RegExp(`exec -T caddy printenv ${key}\\b`), key);
});
