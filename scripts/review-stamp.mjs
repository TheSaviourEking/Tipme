// Which code the review pictures are taken from. The screenshot step writes this before it shoots, and
// the gallery page only ever reads it back: the page is never stamped from git at generation time,
// because it can be regenerated later, after the code has moved on.
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
