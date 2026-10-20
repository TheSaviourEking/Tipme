#!/usr/bin/env node
// Rollback drill on the local staging stack (PR-010, Review Focus 5):
//   version A is running → deploy version B, which adds a migration → roll back to A without
//   undoing the migration → the full release check must pass on A against B's newer schema.
// Usage (after `pnpm staging:local:up <A>` and `node scripts/staging-local.mjs release-staff`):
//   node scripts/rollback-drill.mjs <A tag>
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const a = process.argv[2];
if (!a) {
  console.error(
    'usage: node scripts/rollback-drill.mjs <tag of the running version A>',
  );
  process.exit(2);
}
const b = 'b0000000d1';
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });

// Version B = this tree plus one expand-only migration (a nullable column the old code ignores).
const dir = mkdtempSync(join(tmpdir(), 'tipme-drill-'));
try {
  cpSync('.', dir, {
    recursive: true,
    filter: (src) =>
      !/(^|\/)(node_modules|dist|\.next|\.turbo|\.git|test-results|\.superpowers|deploy\/local\/data)(\/|$)/.test(
        src,
      ),
  });
  const drizzle = join(dir, 'packages/database/drizzle');
  writeFileSync(
    join(drizzle, '0099_rollback_drill.sql'),
    'ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "rollback_drill_note" text;\n',
  );
  const journalPath = join(drizzle, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8'));
  journal.entries.push({
    idx: journal.entries.length,
    version: '7',
    when: Date.now(),
    tag: '0099_rollback_drill',
    breakpoints: true,
  });
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  console.log(`==> Building version B (${b}) with an extra migration`);
  run(
    'docker',
    ['build', '-f', 'deploy/Dockerfile', '-t', `tipme-app:${b}`, '.'],
    { cwd: dir },
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`==> Deploying B (${b}): backup, migrate, switch`);
run('node', ['scripts/staging-local.mjs', 'deploy', b]);
run('node', [
  'scripts/staging-local.mjs',
  'check',
  'read-only',
  '--expect-version',
  b,
]);

console.log(`==> Rolling back to A (${a}); the database keeps B's migration`);
run('node', ['scripts/staging-local.mjs', 'rollback', a]);
run('node', [
  'scripts/staging-local.mjs',
  'check',
  'full',
  '--expect-version',
  a,
]);
console.log(
  `Rollback drill PASSED: ${a} → ${b} → ${a}, full check green on the newer schema.`,
);
