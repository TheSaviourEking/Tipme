import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { installHooks } from './install-git-hooks.mjs';

const hook = readFileSync(new URL('./hooks/pre-push', import.meta.url), 'utf8');

test('the pre-push hook runs the fast checks, never rebuilds the web app, and runs e2e only on request', () => {
  accessSync(new URL('./hooks/pre-push', import.meta.url), constants.X_OK);
  for (const command of [
    'pnpm format:check',
    'pnpm lint',
    'pnpm typecheck',
    'node --test scripts/*.test.mjs',
    "--filter='!@tipme/web'",
    'pnpm --filter @tipme/web test',
  ])
    assert.ok(hook.includes(command), command);
  // `pnpm test` rebuilds the web app and breaks a running `next start`.
  assert.equal(/^\s*pnpm test\s*$/m.test(hook), false);
  assert.match(hook, /TIPME_PREPUSH_E2E/);
  assert.match(hook, /--no-verify/);
});

test('installing points git at scripts/hooks, and does nothing on CI', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tipme-hooks-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    assert.equal(installHooks({ cwd: repo, env: { CI: 'true' } }), 'skipped');
    assert.equal(installHooks({ cwd: repo, env: {} }), 'installed');
    assert.equal(
      execFileSync('git', ['config', '--get', 'core.hooksPath'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim(),
      'scripts/hooks',
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('outside a git checkout (an exported tarball), installing is a no-op', () => {
  const folder = mkdtempSync(join(tmpdir(), 'tipme-nogit-'));
  try {
    assert.equal(installHooks({ cwd: folder, env: {} }), 'skipped');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
