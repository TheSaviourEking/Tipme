import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { DOC_REGIONS, applyRegions, routesOf } from './generate-docs.mjs';
import {
  ATTEMPT_TRANSITIONS,
  PAYOUT_TRANSITIONS,
  TIP_TRANSITIONS,
} from '../packages/domain/src/state-machines.ts';

// PR-014: the documents PRD §15 asks for before money moves. The facts in them are generated
// from the code (the API's own route table, the domain's own state machines), so these tests
// are what keep them true: a stale document, or a new unreviewed public route, fails here.

const read = (path) => readFileSync(resolve(path), 'utf8');
const openapi = JSON.parse(read('docs/api/openapi.json'));
const routes = routesOf(openapi);

test('the generated parts of the documents are current (pnpm docs:generate rewrites them)', () => {
  for (const [file, regions] of Object.entries(DOC_REGIONS(openapi))) {
    const text = read(file);
    assert.equal(
      applyRegions(text, regions),
      text,
      `${file} is out of date: run pnpm docs:generate`,
    );
  }
});

// Public routes (no session, no token, no signature) that have been reviewed. A new one fails
// the next test until someone decides it is meant to be public and adds it here AND explains it
// in docs/security/access-control.md.
const PUBLIC_REVIEWED = [
  'GET /health',
  'GET /health/backups',
  'GET /health/live',
  'GET /health/ready',
  'GET /health/release',
  'POST /v1/auth/code',
  'POST /v1/auth/email-recovery/confirm',
  'POST /v1/auth/email-recovery/propose',
  'POST /v1/auth/email-recovery/start',
  'POST /v1/auth/email/confirm',
  'POST /v1/auth/recover',
  'POST /v1/auth/recover/code',
  'POST /v1/auth/recover/complete',
  'POST /v1/auth/verify',
  'GET /v1/avatars/{profileId}/{file}',
  'POST /v1/events',
  'GET /v1/handles/{handle}/availability',
  'GET /v1/profiles/{handle}',
  'POST /v1/profiles/{handle}/report',
  'POST /v1/tip-intents',
  'POST /v1/tip-quotes',
  'POST /v1/vitals',
];

// Public routes that exist only while payments or messages are pretend. They are refused in
// production and are not rate-limited, so a new one must be reviewed as well.
const PRETEND_PUBLIC_REVIEWED = [
  'GET /v1/dev/inbox',
  'GET /v1/diagnostics/trace-probe/{jobId}',
  'GET /v1/mock-provider/checkout/{reference}',
  'POST /v1/dev/jobs/weekly-report',
  'POST /v1/diagnostics/trace-probe',
  'POST /v1/mock-provider/checkout/{reference}',
];

const SIGNED_PROVIDER_REVIEWED = [
  'POST /v1/webhooks/bachs',
  'POST /v1/webhooks/mail/{provider}',
  'POST /v1/webhooks/mock',
];

test('the pretend-only public routes are exactly the reviewed ones', () => {
  assert.deepEqual(
    routes
      .filter((r) => r.access === 'public' && r.pretendOnly)
      .map((r) => r.key)
      .sort(),
    [...PRETEND_PUBLIC_REVIEWED].sort(),
    'a pretend-only public route was added or removed: review it, then update this list',
  );
});

test('payment and mail webhooks require provider signatures', () => {
  assert.deepEqual(
    routes
      .filter((r) => r.access === 'provider-signature')
      .map((r) => r.key)
      .sort(),
    [...SIGNED_PROVIDER_REVIEWED].sort(),
  );
});

test('the public routes are exactly the reviewed ones, and each state-changing one is rate-limited', () => {
  const realPublic = routes.filter(
    (r) => r.access === 'public' && !r.pretendOnly,
  );
  assert.deepEqual(
    realPublic.map((r) => r.key).sort(),
    [...PUBLIC_REVIEWED].sort(),
    'a public route was added or removed: review it, then update this list and the access-control document',
  );
  for (const route of realPublic.filter((r) => r.changesState))
    assert.ok(
      route.rateLimit,
      `${route.key} changes state and is public, so it needs a rate limit`,
    );
});

test('recipient and staff routes are never public, and every state-changing one needs the CSRF check', () => {
  for (const route of routes) {
    if (route.path.startsWith('/v1/me/'))
      assert.equal(route.access, 'recipient', route.key);
    if (route.path.startsWith('/v1/ops/') && route.access !== 'public')
      assert.match(route.access, /^staff/, route.key);
    if (
      ['recipient', 'staff', 'staff-grant'].includes(route.access) &&
      route.changesState
    )
      assert.equal(
        route.csrf,
        true,
        `${route.key} changes state with a session but has no CSRF check`,
      );
  }
  // Nothing under /v1/me or the admin area may be public.
  for (const route of routes.filter((r) => r.access === 'public'))
    assert.ok(
      !/^\/v1\/(me|ops)\//.test(route.path) || route.path === '/v1/ops/me',
      route.key,
    );
});

test('every admin route that needs a grant names one permission, and the document explains each permission', () => {
  const doc = read('docs/security/access-control.md');
  const used = new Set();
  for (const route of routes.filter((r) => r.access === 'staff-grant')) {
    assert.ok(route.permission, `${route.key} needs a permission`);
    used.add(route.permission);
  }
  assert.ok(used.size >= 10);
  for (const permission of used)
    assert.ok(
      doc.includes(`\`${permission}\``),
      `${permission} is not explained in access-control.md`,
    );
});

test('state machines: finished states have no way out, every state can be reached, and a paid payout can only be reversed', () => {
  const tables = {
    tip: [TIP_TRANSITIONS, 'DRAFT'],
    attempt: [ATTEMPT_TRANSITIONS, 'CREATED'],
    payout: [PAYOUT_TRANSITIONS, 'REQUESTED'],
  };
  for (const [name, [table, start]] of Object.entries(tables)) {
    const reached = new Set([start]);
    for (const state of reached)
      for (const next of table[state]) reached.add(next);
    assert.deepEqual(
      [...reached].sort(),
      Object.keys(table).sort(),
      `${name}: unreachable state`,
    );
    for (const [state, exits] of Object.entries(table))
      for (const exit of exits)
        assert.ok(
          table[exit] !== undefined,
          `${name}: ${state} → ${exit} is not a state`,
        );
  }
  for (const done of ['SUCCEEDED', 'FAILED', 'CANCELLED'])
    assert.deepEqual(TIP_TRANSITIONS[done], [], done);
  for (const done of ['VERIFIED_SUCCEEDED', 'VERIFIED_FAILED', 'EXPIRED'])
    assert.deepEqual(ATTEMPT_TRANSITIONS[done], [], done);
  assert.deepEqual(PAYOUT_TRANSITIONS.PAID, ['REVERSED']);
  // A success can never be taken back by the tip's own machine (a refund is a separate record).
  assert.ok(!TIP_TRANSITIONS.SUCCEEDED.includes('FAILED'));
  // An unknown attempt may resolve to a known pending checkout or a verified verdict,
  // but it can never return to CREATED and permit another provider write.
  assert.deepEqual([...ATTEMPT_TRANSITIONS.UNKNOWN].sort(), [
    'PENDING',
    'VERIFIED_FAILED',
    'VERIFIED_SUCCEEDED',
  ]);
});

test('the files the documents point to exist', () => {
  const docs = [
    'docs/security/access-control.md',
    'docs/security/threat-model.md',
    'docs/architecture/state-machines.md',
    'docs/quality/test-plan.md',
  ];
  const prefixes = /^(apps|packages|tests|scripts|docs|deploy|\.github)\//;
  for (const doc of docs) {
    assert.ok(existsSync(resolve(doc)), `${doc} is missing`);
    for (const [, ref] of read(doc).matchAll(
      /`([^`\s]+\.[a-z]{2,4})(?::\d+)?`/g,
    )) {
      if (!prefixes.test(ref) || ref.includes('*') || ref.includes('<'))
        continue;
      assert.ok(
        existsSync(resolve(ref)),
        `${doc} points to ${ref}, which does not exist`,
      );
    }
  }
});
