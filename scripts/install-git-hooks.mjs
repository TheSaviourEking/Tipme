#!/usr/bin/env node
// Runs on `pnpm install` (the `prepare` script): points git at the repository's own hooks in
// scripts/hooks, so every clone and worktree runs the same pre-push checks. Skipped on CI and
// outside a git checkout.
import { execFileSync } from 'node:child_process';

export function installHooks({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.CI) return 'skipped';
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: 'ignore' });
  } catch {
    return 'skipped';
  }
  execFileSync('git', ['config', 'core.hooksPath', 'scripts/hooks'], { cwd });
  return 'installed';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = installHooks();
  if (result === 'installed')
    console.log('Git hooks installed: pre-push runs the fast checks.');
}
