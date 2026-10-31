import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

// The real edge Caddyfile (deploy/edge/Caddyfile) in front of tiny stand-in APIs, on a
// throwaway Docker network. Hosts are passed as http:// addresses through the same
// environment placeholders the server uses, which makes Caddy serve plain HTTP for them
// (no certificates, no test switch in the Caddyfile).
const docker = (args, options = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', ...options });
const haveDocker = !docker(['info']).error && docker(['info']).status === 0;
const skip = haveDocker ? false : 'docker is not available';

const id = randomBytes(4).toString('hex');
const NET = `tipme-edgetest-${id}`;
const CADDY = `${NET}-caddy`;
const STAGING_HOST = 'staging.edge.test';
const PRODUCTION_HOST = 'production.edge.test';
const CADDY_IMAGE = 'caddy:2.10.2-alpine';
const NODE_IMAGE = 'node:24.22.0-alpine';
const created = [];
let flags;
let port;

// A stand-in API: /health/ready is 200, or 503 while <flags>/<name>.notready exists or after
// SIGTERM (like the real API draining), /health/live is always 200, /who names the copy.
const UPSTREAM = `
const http = require('node:http');
const fs = require('node:fs');
const name = process.env.NAME;
let draining = false;
http.createServer((req, res) => {
  if (req.url === '/health/ready') {
    const notReady = draining || fs.existsSync('/flags/' + name + '.notready');
    res.writeHead(notReady ? 503 : 200);
    return res.end(notReady ? 'notready' : 'ready');
  }
  res.writeHead(200);
  res.end(req.url === '/who' ? name : 'ok');
}).listen(4000);
process.on('SIGTERM', () => {
  draining = true;
  setTimeout(() => process.exit(0), 3000);
});
`;

function upstream(name, alias) {
  const run = docker([
    'run',
    '-d',
    '--name',
    `${NET}-${name}`,
    '--network',
    NET,
    '--network-alias',
    alias,
    '-e',
    `NAME=${name}`,
    '-v',
    `${flags}:/flags:ro`,
    NODE_IMAGE,
    'node',
    '-e',
    UPSTREAM,
  ]);
  assert.equal(run.status, 0, run.stderr);
  created.push(`${NET}-${name}`);
}

// Host is a forbidden header for fetch, so this uses node:http.
function get(host, path = '/who') {
  return new Promise((resolveGet) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { Host: host } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolveGet({ status: res.statusCode, body }));
      },
    );
    req.on('error', () => resolveGet({ status: 0, body: '' }));
    req.setTimeout(8000, () => req.destroy());
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const burst = (n, host = PRODUCTION_HOST) =>
  Promise.all(Array.from({ length: n }, () => get(host)));

async function waitFor(check, label, tries = 60) {
  for (let i = 0; i < tries; i++) {
    if (await check()) return;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${label}`);
}

before(async () => {
  if (skip) return;
  // Docker would create a directory in place of a missing file mount.
  assert.ok(
    existsSync(resolve('deploy/edge/Caddyfile')),
    'deploy/edge/Caddyfile',
  );
  flags = mkdtempSync(join(tmpdir(), 'tipme-edgetest-'));
  assert.equal(docker(['network', 'create', NET]).status, 0);
  upstream('staging', 'staging-api');
  for (const n of [1, 2, 3])
    upstream(`blue-${n}`, `tipme-production-api-blue-${n}`);
  const run = docker([
    'run',
    '-d',
    '--name',
    CADDY,
    '--network',
    NET,
    '-p',
    '127.0.0.1::80',
    '-e',
    'ACME_EMAIL=ops@edge.test',
    '-e',
    `STAGING_API_HOST=http://${STAGING_HOST}`,
    '-e',
    `PRODUCTION_API_HOST=http://${PRODUCTION_HOST}`,
    '-v',
    `${resolve('deploy/edge/Caddyfile')}:/etc/caddy/Caddyfile:ro`,
    CADDY_IMAGE,
  ]);
  assert.equal(run.status, 0, run.stderr);
  created.push(CADDY);
  const mapped = docker(['port', CADDY, '80/tcp']).stdout.trim();
  port = Number(mapped.split('\n')[0].split(':').pop());
  await waitFor(
    async () => (await get(STAGING_HOST)).status === 200,
    'staging',
  );
  await waitFor(async () => {
    const seen = new Set((await burst(10)).map((r) => r.body));
    return [1, 2, 3].every((n) => seen.has(`blue-${n}`));
  }, 'every ready production copy');
});

after(() => {
  for (const name of created) docker(['rm', '-f', name]);
  docker(['network', 'rm', NET]);
  if (flags) rmSync(flags, { recursive: true, force: true });
});

test('the Caddyfile exists and validates', { skip }, () => {
  assert.ok(existsSync(resolve('deploy/edge/Caddyfile')));
  const result = docker([
    'run',
    '--rm',
    '-e',
    'ACME_EMAIL=ops@edge.test',
    '-e',
    'STAGING_API_HOST=staging.edge.test',
    '-e',
    'PRODUCTION_API_HOST=production.edge.test',
    '-v',
    `${resolve('deploy/edge')}:/etc/caddy:ro`,
    CADDY_IMAGE,
    'caddy',
    'validate',
    '--config',
    '/etc/caddy/Caddyfile',
  ]);
  assert.equal(result.status, 0, result.stderr);
});

test('both hosts route to their own project', { skip }, async () => {
  assert.equal((await get(STAGING_HOST)).body, 'staging');
  assert.match((await get(PRODUCTION_HOST)).body, /^blue-[123]$/);
});

test(
  'production spreads requests over every ready copy',
  { skip },
  async () => {
    const bodies = (await burst(20)).map((r) => r.body);
    assert.ok(
      [1, 2, 3].every((n) => bodies.includes(`blue-${n}`)),
      bodies.join(),
    );
  },
);

// Only one colour runs at a time, so three of the six names never resolve: the normal state.
test(
  'with one colour running (three of the six names exist) nothing fails',
  { skip },
  async () => {
    const results = await burst(30);
    assert.deepEqual(
      results.filter((r) => r.status !== 200),
      [],
    );
  },
);

test('health-checker noise stays out of the edge log', { skip }, () => {
  const logs = docker(['logs', CADDY]);
  const text = `${logs.stdout}${logs.stderr}`;
  assert.ok(!/health_checker/.test(text), 'health checker lines in the log');
  // The stopped colour's names fail every check; the log must still be usable.
  assert.match(text, /serving initial configuration/);
});

test('a copy failing readiness gets no traffic', { skip }, async () => {
  writeFileSync(join(flags, 'blue-2.notready'), '');
  try {
    // Two failed checks, 2 s apart, take a copy out.
    await sleep(6500);
    const results = await burst(20);
    assert.deepEqual(
      [...new Set(results.map((r) => `${r.status} ${r.body}`))].sort(),
      ['200 blue-1', '200 blue-3'].sort(),
    );
  } finally {
    rmSync(join(flags, 'blue-2.notready'), { force: true });
  }
  await waitFor(async () => {
    const seen = new Set((await burst(10)).map((r) => r.body));
    return seen.has('blue-2');
  }, 'blue-2 to take traffic again');
});

test(
  'a copy stopped mid-traffic costs no failed request',
  { skip },
  async () => {
    let stop = false;
    const statuses = [];
    const traffic = (async () => {
      while (!stop) {
        statuses.push((await get(PRODUCTION_HOST)).status);
        await sleep(25);
      }
    })();
    await sleep(500);
    assert.equal(docker(['stop', '-t', '10', `${NET}-blue-3`]).status, 0);
    await sleep(4000);
    stop = true;
    await traffic;
    assert.ok(statuses.length > 50, `only ${statuses.length} requests`);
    assert.deepEqual(
      statuses.filter((s) => s !== 200),
      [],
    );
  },
);
