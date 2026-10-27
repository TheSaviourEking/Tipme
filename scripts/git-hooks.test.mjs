import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

test('the prepare script succeeds where scripts/ is not copied (the Docker build installs from package.json files alone)', () => {
  const { scripts } = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  const folder = mkdtempSync(join(tmpdir(), 'tipme-docker-'));
  try {
    execFileSync('sh', ['-c', scripts.prepare], { cwd: folder, stdio: 'pipe' });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('the hook clears the git variables git sets for it, so tests that make their own repository never write into this one', () => {
  const repo = mkdtempSync(join(tmpdir(), 'tipme-hookenv-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const bin = join(repo, 'bin');
    execFileSync('mkdir', [bin]);
    const record = join(repo, 'env.txt');
    for (const name of ['pnpm', 'node'])
      writeFileSync(join(bin, name), `#!/bin/sh\nenv >> '${record}'\n`, {
        mode: 0o755,
      });
    execFileSync(
      'bash',
      [fileURLToPath(new URL('./hooks/pre-push', import.meta.url))],
      {
        cwd: repo,
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: repo,
          GIT_DIR: join(repo, '.git'),
          GIT_INDEX_FILE: join(repo, '.git', 'index'),
        },
        stdio: 'pipe',
      },
    );
    const seen = readFileSync(record, 'utf8');
    assert.doesNotMatch(seen, /^GIT_DIR=/m);
    assert.doesNotMatch(seen, /^GIT_INDEX_FILE=/m);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
