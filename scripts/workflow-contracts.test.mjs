import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const LEVELS = { none: 0, read: 1, write: 2 };

/** The permissions a job declares, by job name, from a workflow's top-level `jobs:` block. */
function jobPermissions(source) {
  const lines = source.split('\n');
  const jobs = new Map();
  let job = null;
  let inPermissions = false;
  for (const line of lines.slice(lines.indexOf('jobs:') + 1)) {
    const name = line.match(/^ {2}([a-zA-Z0-9_-]+):$/);
    if (name) {
      job = name[1];
      jobs.set(job, new Map());
      inPermissions = false;
    } else if (/^ {4}permissions:$/.test(line)) {
      inPermissions = true;
    } else if (inPermissions) {
      const entry = line.match(/^ {6}([a-z-]+): (read|write|none)$/);
      if (entry) jobs.get(job).set(entry[1], entry[2]);
      else if (line.trim() && !line.trim().startsWith('#'))
        inPermissions = false;
    }
  }
  return jobs;
}

// GitHub validates every job of a called workflow before anything starts, even jobs that would be
// skipped, so the caller must grant the highest level any of them asks for.
test('the staging caller grants every permission requested by any job of reusable CI', () => {
  const staging = readFileSync('.github/workflows/deploy-staging.yml', 'utf8');
  const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
  const granted = jobPermissions(staging).get('checks');
  assert.ok(granted?.size, 'the checks job declares its permissions');

  const missing = [];
  for (const [job, requested] of jobPermissions(ci)) {
    for (const [permission, level] of requested) {
      if (LEVELS[granted.get(permission) ?? 'none'] < LEVELS[level])
        missing.push(`${job}: ${permission} ${level}`);
    }
  }

  assert.deepEqual(missing, []);
});

// The website is built in CI and shipped with the API since Vercel paused it (26 Nov 2026). Its
// image bakes in the browser's settings, so each environment builds its own, from its own values.
const step = (source, name) => {
  const start = source.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `no step "${name}"`);
  const next = source.indexOf('\n      - ', start + 1);
  return source.slice(start, next < 0 ? undefined : next);
};

for (const [file, stack, other] of [
  ['deploy-staging.yml', 'staging', 'production'],
  ['deploy-production.yml', 'production', 'staging'],
]) {
  test(`${file} builds the ${stack} web image with its build args, before shipping`, () => {
    const source = readFileSync(`.github/workflows/${file}`, 'utf8');
    const build = step(source, `Build the web image (${stack})`);
    assert.match(build, /docker build -f deploy\/web\.Dockerfile/);
    assert.match(build, new RegExp(`-t "tipme-web-${stack}:\\$VERSION"`));
    assert.doesNotMatch(source, new RegExp(`tipme-web-${other}`));
    for (const arg of [
      'TIPME_BUILD_VERSION',
      'SITE_URL',
      'SITE_INDEXING',
      'NEXT_PUBLIC_API_ORIGIN',
      'NEXT_PUBLIC_PREVIEW_GATE',
      'NEXT_PUBLIC_SENTRY_DSN',
      'NEXT_PUBLIC_SENTRY_ENVIRONMENT',
      'NEXT_PUBLIC_PRETEND_DELIVERY',
    ])
      assert.match(
        build,
        new RegExp(`--build-arg ${arg}\\b`),
        `${file}: ${arg}`,
      );
    assert.ok(
      source.indexOf(`- name: Build the web image (${stack})`) <
        source.indexOf('- name: Ship and deploy'),
      'built before it ships',
    );
    // Every variable the build reads is listed in the header comment.
    const header = source.slice(0, source.indexOf('\nname:'));
    for (const [, name] of build.matchAll(/vars\.([A-Z0-9_]+)/g))
      assert.match(
        header,
        new RegExp(`\\b${name}\\b`),
        `${file} header: ${name}`,
      );
  });
}

test('production never builds the pretend inbox or the preview gate into its website', () => {
  const build = step(
    readFileSync('.github/workflows/deploy-production.yml', 'utf8'),
    'Build the web image (production)',
  );
  // Fixed blank here, never a variable: on, they open /dev/inbox and send preview credentials.
  assert.match(build, /NEXT_PUBLIC_PRETEND_DELIVERY: ''/);
  assert.match(build, /NEXT_PUBLIC_PREVIEW_GATE: ''/);
});

// PRODUCTION_WEB_URL is documented as the apex (production.md), but the canonical address every
// prerendered page carries is the www host: production's SITE_URL is its own variable, no fallback.
test('production bakes SITE_URL from PRODUCTION_SITE_URL only', () => {
  const build = step(
    readFileSync('.github/workflows/deploy-production.yml', 'utf8'),
    'Build the web image (production)',
  );
  assert.match(build, /SITE_URL: \$\{\{ vars\.PRODUCTION_SITE_URL \}\}/);
  assert.doesNotMatch(build, /SITE_URL: .*PRODUCTION_WEB_URL/);
});
