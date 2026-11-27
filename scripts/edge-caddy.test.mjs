import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { constants as zlibConstants, createGunzip } from 'node:zlib';
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
// The websites (self-hosted since 26 Nov 2026). The production web host is given with :80 rather
// than http://, because the redirects name it after https:// (as edge.env does: a bare host).
// The staging web host takes :80 too, since www.<staging host> is built from it.
// Caddy serves a site on the HTTP port without certificates, so no test switch is needed.
const STAGING_WEB_HOST = 'staging-web.edge.test';
const WWW_STAGING_HOST = `www.${STAGING_WEB_HOST}`;
const WEB_HOST = 'www.edge.test';
const APEX_HOST = 'apex.edge.test';
const EDGE_ENV = [
  'ACME_EMAIL=ops@edge.test',
  `STAGING_API_HOST=http://${STAGING_HOST}`,
  `PRODUCTION_API_HOST=http://${PRODUCTION_HOST}`,
  `STAGING_WEB_HOST=${STAGING_WEB_HOST}:80`,
  `PRODUCTION_WEB_HOST=${WEB_HOST}:80`,
  `PRODUCTION_APEX_HOST=http://${APEX_HOST}`,
];
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
  // The live stream: event-stream headers, a heartbeat every 500 ms, and it never ends. No
  // Cache-Control: no-transform here (the real API sends it, and Caddy honours it), so this tests
  // the Caddyfile's own path matcher.
  if (req.url === '/v1/me/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' });
    // A first frame past the encoder's 512-byte minimum: without the matcher it would be compressed.
    res.write(': ' + 'p'.repeat(600) + '\\n\\n');
    const beat = setInterval(() => res.write(': hb\\n\\n'), 500);
    return req.on('close', () => clearInterval(beat));
  }
  // Big enough for Caddy's encoder (its minimum is 512 bytes).
  if (req.url === '/big') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end(name.repeat(400));
  }
  res.writeHead(200);
  res.end(req.url === '/who' ? name : 'ok');
}).listen(4000);
process.on('SIGTERM', () => {
  draining = true;
  setTimeout(() => process.exit(0), 3000);
});
`;

// A stand-in website, like Next's standalone server: /api/version is the health check (503 while
// <flags>/<name>.notready exists), /stream sends a page in three parts 400 ms apart (as a streamed
// render does), /_next/static/ carries Next's own immutable cache header, and on SIGTERM it stops
// taking connections and finishes the requests it has (Next's start-server.js).
const WEB = `
const http = require('node:http');
const fs = require('node:fs');
const name = process.env.NAME;
const server = http.createServer((req, res) => {
  if (req.url === '/api/version') {
    const notReady = fs.existsSync('/flags/' + name + '.notready');
    res.writeHead(notReady ? 503 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ version: name }));
  }
  // As a Next that compresses its own answers (next start): a streamed page, gzipped here, each part
  // flushed through the encoder as it is written.
  if (req.url === '/stream-gzipped') {
    const zlib = require('node:zlib');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'gzip' });
    const gz = zlib.createGzip();
    gz.pipe(res);
    gz.write('<!doctype html><p>shell</p>' + '<!-- ' + 's'.repeat(700) + ' -->');
    gz.flush();
    setTimeout(() => { gz.write('<p>part two</p>'); gz.flush(); }, 400);
    return setTimeout(() => gz.end('<p>end</p>'), 800);
  }
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // Past the encoder's 512-byte minimum, so compression applies to the stream too.
    res.write('<!doctype html><p>shell</p>' + '<!-- ' + 's'.repeat(700) + ' -->');
    setTimeout(() => res.write('<p>part two</p>'), 400);
    return setTimeout(() => res.end('<p>end</p>'), 800);
  }
  // A page of this build: its assets exist only on this copy (as a Next build's hashed chunks).
  if (req.url === '/page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end('<!doctype html><script src="/_next/static/build-' + name + '/app.js"></script>' +
      '<link rel="stylesheet" href="/_next/static/build-' + name + '/app.css">' + name);
  }
  if (req.url.startsWith('/_next/static/build-')) {
    const mine = req.url.startsWith('/_next/static/build-' + name + '/');
    res.writeHead(mine ? 200 : 404, { 'cache-control': 'public, max-age=31536000, immutable' });
    return res.end(mine ? 'asset of ' + name : 'not in this build');
  }
  if (req.url.startsWith('/_next/static/')) {
    res.writeHead(200, {
      'content-type': 'application/javascript; charset=UTF-8',
      'cache-control': 'public, max-age=31536000, immutable',
    });
    return res.end('/* ' + 'x'.repeat(2000) + ' */');
  }
  // Every page carries the app's own security headers (next.config.ts).
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'self'",
  });
  res.end(req.url === '/who' ? name : '<!doctype html>' + name.repeat(300));
}).listen(3000);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

function web(name, alias) {
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
    WEB,
  ]);
  assert.equal(run.status, 0, run.stderr);
  created.push(`${NET}-${name}`);
}

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
function get(host, path = '/who', headers = {}) {
  return new Promise((resolveGet) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { Host: host, ...headers } },
      (res) => {
        let body = '';
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () =>
          resolveGet({ status: res.statusCode, body, headers: res.headers }),
        );
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
  web('staging-web', 'staging-web');
  // Both website colours, as while a deploy overlaps them.
  web('web-blue', 'tipme-production-web-blue-1');
  web('web-green', 'tipme-production-web-green-1');
  const run = docker([
    'run',
    '-d',
    '--name',
    CADDY,
    '--network',
    NET,
    '-p',
    '127.0.0.1::80',
    ...EDGE_ENV.flatMap((setting) => ['-e', setting]),
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
  await waitFor(async () => {
    const seen = new Set((await burst(10, WEB_HOST)).map((r) => r.body));
    return seen.has('web-blue') && seen.has('web-green');
  }, 'both website colours');
});

after(() => {
  for (const name of created) docker(['rm', '-f', name]);
  docker(['network', 'rm', NET]);
  if (flags) rmSync(flags, { recursive: true, force: true });
});

test('the Caddyfile exists and validates', { skip }, () => {
  assert.ok(existsSync(resolve('deploy/edge/Caddyfile')));
  const result = validate(EXAMPLE_ENV);
  assert.equal(result.status, 0, result.stderr);
});

// edge.env.example's names, with the bare hosts the server's file has.
const EXAMPLE_ENV = [
  'ACME_EMAIL=ops@edge.test',
  'STAGING_API_HOST=staging.edge.test',
  'PRODUCTION_API_HOST=production.edge.test',
  'STAGING_WEB_HOST=staging-web.edge.test',
  'PRODUCTION_WEB_HOST=www.edge.test',
  'PRODUCTION_APEX_HOST=edge.test',
];
const validate = (env) =>
  docker([
    'run',
    '--rm',
    ...env.flatMap((setting) => ['-e', setting]),
    '-v',
    `${resolve('deploy/edge')}:/etc/caddy:ro`,
    CADDY_IMAGE,
    'caddy',
    'validate',
    '--config',
    '/etc/caddy/Caddyfile',
  ]);

// ship-production.sh validates the new Caddyfile with the server's edge.env before it replaces the
// running one, so an edge.env without the website's hosts stops the ship before anything changes.
test(
  'the Caddyfile refuses an edge.env without the website hosts',
  { skip },
  () => {
    for (const missing of [
      'STAGING_WEB_HOST',
      'PRODUCTION_WEB_HOST',
      'PRODUCTION_APEX_HOST',
    ]) {
      const result = validate(
        EXAMPLE_ENV.filter((s) => !s.startsWith(`${missing}=`)),
      );
      assert.notEqual(result.status, 0, `valid without ${missing}`);
    }
  },
);

test('edge.env.example names every setting the Caddyfile reads', () => {
  const caddyfile = readFileSync(resolve('deploy/edge/Caddyfile'), 'utf8');
  const example = readFileSync(resolve('deploy/edge/edge.env.example'), 'utf8');
  const read = new Set(
    [...caddyfile.matchAll(/\{\$([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
  );
  const named = new Set(
    [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
  );
  assert.deepEqual(
    [...read].filter((n) => !named.has(n)),
    [],
  );
  for (const name of [
    'STAGING_WEB_HOST',
    'PRODUCTION_WEB_HOST',
    'PRODUCTION_APEX_HOST',
  ])
    assert.ok(read.has(name), `the Caddyfile does not read ${name}`);
});

test('each website host routes to its own project', { skip }, async () => {
  assert.equal((await get(STAGING_WEB_HOST)).body, 'staging-web');
  assert.match((await get(WEB_HOST)).body, /^web-(blue|green)$/);
});

test(
  'the apex redirects permanently to the www host, path and query kept',
  { skip },
  async () => {
    const { status, headers } = await get(APEX_HOST, '/@ada?from=qr&x=1');
    assert.equal(status, 308);
    assert.equal(headers.location, `https://${WEB_HOST}:80/@ada?from=qr&x=1`);
  },
);

test(
  'www.<staging host> redirects permanently to the staging host, path and query kept',
  { skip },
  async () => {
    const { status, headers } = await get(
      WWW_STAGING_HOST,
      '/@ada?from=qr&x=1',
    );
    assert.equal(status, 308);
    assert.equal(
      headers.location,
      `https://${STAGING_WEB_HOST}:80/@ada?from=qr&x=1`,
    );
  },
);

for (const host of [STAGING_WEB_HOST, WEB_HOST]) {
  test(
    `the website keeps its own security headers and gains HSTS (${host})`,
    { skip },
    async () => {
      const { headers } = await get(host, '/');
      assert.match(headers['strict-transport-security'] ?? '', /^max-age=\d+/);
      // Set once, by the app; the edge does not add a second copy.
      assert.equal(headers['x-content-type-options'], 'nosniff');
      assert.equal(headers['content-security-policy'], "default-src 'self'");
      assert.equal(headers.server, undefined);
    },
  );

  test(
    `a streamed page is compressed and still arrives part by part (${host})`,
    { skip },
    async () => {
      const { encoding, seen } = await decodedArrival(host, '/stream', [
        'shell',
        'part two',
        'end',
      ]);
      assert.equal(encoding, 'gzip');
      // The page's parts are 400 ms apart; a buffering edge would send them together at the end.
      assert.ok(seen.shell < 300, `the shell came after ${seen.shell} ms`);
      assert.ok(
        seen['part two'] - seen.shell > 250,
        `the parts came together (${JSON.stringify(seen)})`,
      );
    },
  );

  // Whichever side compresses: a page Next already gzipped is passed on encoded once (never
  // gzip inside gzip), decodes to the page, and still arrives part by part.
  test(
    `an answer the app already compressed is not compressed again, and still streams (${host})`,
    { skip },
    async () => {
      const { encoding, seen } = await decodedArrival(host, '/stream-gzipped', [
        'shell',
        'part two',
        'end',
      ]);
      assert.equal(encoding, 'gzip');
      assert.ok(
        'end' in seen,
        `the page did not decode to its end (${JSON.stringify(seen)})`,
      );
      assert.ok(seen.shell < 300, `the shell came after ${seen.shell} ms`);
      assert.ok(
        seen['part two'] - seen.shell > 250,
        `the parts came together (${JSON.stringify(seen)})`,
      );
    },
  );

  test(
    `Next's own long cache on /_next/static survives the edge (${host})`,
    { skip },
    async () => {
      const { status, headers } = await get(
        host,
        '/_next/static/chunks/app.js',
        {
          'Accept-Encoding': 'zstd, gzip',
        },
      );
      assert.equal(status, 200);
      assert.equal(
        headers['cache-control'],
        'public, max-age=31536000, immutable',
      );
      assert.match(headers['content-encoding'] ?? '', /^(zstd|gzip)$/);
    },
  );
}

test(
  'a website colour failing its health check gets no traffic',
  { skip },
  async () => {
    writeFileSync(join(flags, 'web-green.notready'), '');
    try {
      await sleep(6500);
      const bodies = (await burst(20, WEB_HOST)).map(
        (r) => `${r.status} ${r.body}`,
      );
      assert.deepEqual([...new Set(bodies)], ['200 web-blue']);
    } finally {
      rmSync(join(flags, 'web-green.notready'), { force: true });
    }
    await waitFor(async () => {
      const seen = new Set((await burst(10, WEB_HOST)).map((r) => r.body));
      return seen.has('web-green');
    }, 'web-green to take traffic again');
  },
);

// A browser with a cookie jar: the page, then every /_next/static asset it names. During a switch
// both builds run; round-robin sent half the assets to the build that lacks them (a 404 per chunk).
const cookieOf = (headers) =>
  (headers['set-cookie'] ?? []).map((c) => c.split(';')[0]);
async function visit(jar, failures) {
  const send = () => (jar.size ? { Cookie: [...jar.values()].join('; ') } : {});
  const remember = (headers) => {
    for (const c of cookieOf(headers)) jar.set(c.split('=')[0], c);
  };
  const page = await get(WEB_HOST, '/page', send());
  remember(page.headers);
  if (page.status !== 200) return failures.push(`page ${page.status}`);
  for (const [, asset] of page.body.matchAll(
    /(?:src|href)="(\/_next\/static\/[^"]+)"/g,
  )) {
    const answer = await get(WEB_HOST, asset, send());
    remember(answer.headers);
    if (answer.status !== 200)
      failures.push(
        `${asset} ${answer.status} after a page from ${page.body.slice(-9)}`,
      );
  }
}

test(
  "during a website switch every page gets its own build's assets, and a stopped colour's visitors move",
  { skip },
  async () => {
    const failures = [];
    let visits = 0;
    let stop = false;
    // A returning browser keeps its jar for the whole switch; each other visit is a new browser.
    const returning = new Map();
    const traffic = (async () => {
      while (!stop) {
        await visit(new Map(), failures);
        await visit(returning, failures);
        visits += 2;
        await sleep(20);
      }
    })();
    try {
      // Both colours serve (the overlap), then the deploy drains the old one and stops it.
      await sleep(2000);
      writeFileSync(join(flags, 'web-green.notready'), '');
      await sleep(6500);
      const exit = await new Promise((done) =>
        spawn('docker', ['stop', '-t', '15', `${NET}-web-green`]).on(
          'exit',
          done,
        ),
      );
      assert.equal(exit, 0);
      await sleep(3000);
    } finally {
      stop = true;
      await traffic;
      rmSync(join(flags, 'web-green.notready'), { force: true });
    }
    assert.ok(visits > 40, `only ${visits} visits`);
    assert.deepEqual(failures, []);
    // Green back for the tests after this one.
    assert.equal(docker(['start', `${NET}-web-green`]).status, 0);
    await waitFor(async () => {
      const seen = new Set((await burst(10, WEB_HOST)).map((r) => r.body));
      return seen.has('web-green');
    }, 'web-green to take traffic again');
  },
);

// The deploy stops the old colour once the new one serves: no visitor may see an error.
test(
  'a website colour stopped mid-traffic costs no failed request',
  { skip },
  async () => {
    let stop = false;
    const statuses = [];
    // Three browsers at once, with no cookie (each request picks a copy at random) and no drain
    // first: the worst case, a copy that stopped on its own.
    const traffic = Promise.all(
      [1, 2, 3].map(async () => {
        while (!stop) {
          statuses.push((await get(WEB_HOST)).status);
          await sleep(25);
        }
      }),
    );
    await sleep(500);
    // Not spawnSync: the traffic must keep flowing while the copy shuts down.
    const stopped = Date.now();
    const exit = await new Promise((done) =>
      spawn('docker', ['stop', '-t', '15', `${NET}-web-green`]).on(
        'exit',
        done,
      ),
    );
    const stopMs = Date.now() - stopped;
    assert.equal(exit, 0);
    await sleep(4000);
    stop = true;
    await traffic;
    assert.ok(statuses.length > 50, `only ${statuses.length} requests`);
    assert.deepEqual(
      statuses.filter((s) => s !== 200),
      [],
    );
    // It finished its requests and left well inside the 20 s stop grace (compose.production.yml).
    assert.ok(stopMs < 10_000, `the copy took ${stopMs} ms to stop`);
    assert.match((await get(WEB_HOST)).body, /^web-blue$/);
  },
);

test('both hosts route to their own project', { skip }, async () => {
  assert.equal((await get(STAGING_HOST)).body, 'staging');
  assert.match((await get(PRODUCTION_HOST)).body, /^blue-[123]$/);
});

/**
 * When each marker first appears in the decompressed body (ms from the request), and the encoding.
 */
function decodedArrival(host, path, markers) {
  return new Promise((resolveArrival, reject) => {
    const started = Date.now();
    const seen = {};
    let text = '';
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { Host: host, 'Accept-Encoding': 'gzip' },
      },
      (res) => {
        const body =
          res.headers['content-encoding'] === 'gzip'
            ? res.pipe(createGunzip({ flush: zlibConstants.Z_SYNC_FLUSH }))
            : res;
        body.on('data', (chunk) => {
          text += chunk.toString('utf8');
          for (const marker of markers)
            if (!(marker in seen) && text.includes(marker))
              seen[marker] = Date.now() - started;
        });
        body.on('end', () =>
          resolveArrival({
            encoding: res.headers['content-encoding'],
            seen,
          }),
        );
        body.on('error', reject);
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('no end in 5 s')));
    req.end();
  });
}

/**
 * The first `count` chunks of a response that may never end, each with its arrival time, and the
 * headers; then the request is dropped.
 */
function firstChunks(host, path, headers = {}, count = 1) {
  return new Promise((resolveFirst, reject) => {
    const started = Date.now();
    const chunks = [];
    const req = request(
      { host: '127.0.0.1', port, path, headers: { Host: host, ...headers } },
      (res) => {
        res.on('data', (chunk) => {
          chunks.push({
            text: chunk.toString('latin1'),
            ms: Date.now() - started,
          });
          if (chunks.length < count) return;
          resolveFirst({
            status: res.statusCode,
            headers: res.headers,
            chunks,
          });
          req.destroy();
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(5000, () =>
      req.destroy(new Error(`fewer than ${count} chunks in 5 s`)),
    );
    req.end();
  });
}
const firstChunk = async (host, path, headers) => {
  const {
    status,
    headers: h,
    chunks,
  } = await firstChunks(host, path, headers, 1);
  return { status, headers: h, chunk: chunks[0].text, ms: chunks[0].ms };
};

for (const host of [STAGING_HOST, PRODUCTION_HOST]) {
  test(
    `the stream paths are not compressed and flush at once (${host})`,
    { skip },
    async () => {
      const first = await firstChunk(host, '/v1/me/events', {
        'Accept-Encoding': 'gzip, zstd',
      });
      assert.equal(first.status, 200);
      assert.equal(first.headers['content-encoding'], undefined);
      assert.match(first.headers['content-type'], /^text\/event-stream/);
      assert.match(first.chunk, /^: p+/);
      assert.ok(first.ms < 2000, `first heartbeat after ${first.ms} ms`);
    },
  );

  test(
    `a small heartbeat after it flushes through at once too (${host})`,
    { skip },
    async () => {
      // Production writes small frames (`retry: 5000`, a 6-byte `: hb`): each must pass the edge
      // when written, not when a buffer fills. The stand-in writes one every 500 ms.
      const { chunks, headers } = await firstChunks(
        host,
        '/v1/me/events',
        { 'Accept-Encoding': 'gzip, zstd' },
        2,
      );
      assert.equal(headers['content-encoding'], undefined);
      assert.match(chunks[1].text, /^: hb/);
      assert.ok(
        chunks[1].ms - chunks[0].ms < 1000,
        `the heartbeat came ${chunks[1].ms - chunks[0].ms} ms after the first chunk`,
      );
    },
  );

  test(`other paths are still compressed (${host})`, { skip }, async () => {
    const first = await firstChunk(host, '/big', {
      'Accept-Encoding': 'gzip, zstd',
    });
    assert.match(first.headers['content-encoding'] ?? '', /^(zstd|gzip)$/);
  });
}

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
