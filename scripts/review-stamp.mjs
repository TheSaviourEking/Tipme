// Which code the review pictures are taken from. The stamp is recorded with the build
// (apps/web/.next/review-stamp.json), copied beside the pictures on every run, and only read back by the
// gallery page. It is never read from git when a run only shoots or only writes the page, because then
// the pictures come from an older build than the checkout.
import { execFileSync } from 'node:child_process';

const gitOutput = (...args) => execFileSync('git', args, { encoding: 'utf8' });

/** The short commit, whether the tree has uncommitted edits, and when (UTC). */
export function readStamp(git = gitOutput, now = new Date()) {
  return {
    sha: git('rev-parse', '--short', 'HEAD').trim(),
    dirty: git('status', '--porcelain').trim() !== '',
    builtAt: now.toISOString().slice(0, 16).replace('T', ' ') + ' UTC',
  };
}

/** The stamp as written, or undefined if it is missing or not a stamp. */
export function parseStamp(text) {
  try {
    const stamp = JSON.parse(text);
    return typeof stamp?.sha === 'string' &&
      typeof stamp.dirty === 'boolean' &&
      typeof stamp.builtAt === 'string'
      ? stamp
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a run writes beside its pictures, given the contents of the stamp recorded with the build (or
 * undefined if there is none: a build made some other way). Nothing is written when it is unknown.
 */
export function stampToCarry(buildStampText) {
  return parseStamp(buildStampText) ? buildStampText : undefined;
}
