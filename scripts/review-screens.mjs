#!/usr/bin/env node
// The owner's local review of the redesign (docs/superpowers/plans/2026-11-03-screen-redesign.md).
//
//   pnpm review:screens   build, then picture every screen in tests/review/screens.ts at desktop and
//                         phone size, and write review-screens/index.html
//   pnpm review:serve     build, then keep the same stack running to click through
//
// Add --no-build to reuse the last build.
import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const mode = process.argv[2];
if (mode !== 'build' && mode !== 'serve') {
  console.error(
    'Usage: node scripts/review-screens.mjs build|serve [--no-build]',
  );
  process.exit(2);
}

const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (!process.argv.includes('--no-build')) {
  // A reused Next cache once built the old CSS and reported success (3 Nov 2026), and a review of an
  // old look is worse than none.
  rmSync('apps/web/.next/cache', { recursive: true, force: true });
  run('pnpm', ['build'], {
    NEXT_PUBLIC_API_ORIGIN: 'http://127.0.0.1:4100',
    NEXT_PUBLIC_PRETEND_DELIVERY: 'on',
  });
}
run('node', ['scripts/prepare-e2e-database.mjs']);

const playwright = [
  'exec',
  'playwright',
  'test',
  '-c',
  'tests/review/playwright.config.ts',
];
if (mode === 'serve') {
  run('pnpm', [...playwright, '--project=serve', '--reporter=line']);
} else {
  rmSync('review-screens', { recursive: true, force: true });
  run('pnpm', [...playwright, '--project=desktop', '--project=phone']);
  run('node', ['scripts/review-gallery.mjs']);
  console.log('Open review-screens/index.html to review.');
}
