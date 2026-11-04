#!/usr/bin/env node
// The owner's local review of the redesign (docs/superpowers/plans/2026-11-03-screen-redesign.md).
//
//   pnpm review:screens   build, then picture every screen in tests/review/screens.ts at desktop and
//                         phone size, and write review-screens/index.html
//   pnpm review:serve     build, then keep the same stack running to click through
//
// Add --no-build to reuse the last build.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readStamp, stampToCarry } from './review-stamp.mjs';
import { laneConfig } from '../tests/lane.mjs';
import { spawnSync } from 'node:child_process';

// Written by the build step below; a build made any other way has none, and the header says unknown.
const BUILD_STAMP = 'apps/web/.next/review-stamp.json';

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
  // Read before the build, so it names the code that is built; written after it, because a build
  // clears its output folder. Stale until then would be wrong, so remove any old one first.
  const stamp = readStamp();
  rmSync(BUILD_STAMP, { force: true });
  run('pnpm', ['build'], {
    NEXT_PUBLIC_API_ORIGIN: laneConfig().apiOrigin,
    NEXT_PUBLIC_PRETEND_DELIVERY: 'on',
  });
  writeFileSync(BUILD_STAMP, JSON.stringify(stamp));
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
  mkdirSync('review-screens', { recursive: true });
  // The stamp of the build being shot, whether or not this run made it; none if it was built another way.
  const carried = stampToCarry(
    existsSync(BUILD_STAMP) ? readFileSync(BUILD_STAMP, 'utf8') : undefined,
  );
  if (carried) writeFileSync('review-screens/stamp.json', carried);
  run('pnpm', [...playwright, '--project=desktop', '--project=phone']);
  run('node', ['scripts/review-gallery.mjs']);
  console.log('Open review-screens/index.html to review.');
}
