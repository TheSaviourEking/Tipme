import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildVersion } from '../src/lib/build-version.ts';

const noGit = () => {
  throw new Error('not a git checkout');
};

// The image is built from a context with no .git (deploy/web.Dockerfile), so the deploy passes the
// version it ships; it must equal what /api/version answers for the deploy's check to pass.
test('the deploy-given version wins: TIPME_BUILD_VERSION, then GIT_SHA', () => {
  assert.equal(
    buildVersion(
      { TIPME_BUILD_VERSION: 'abc123def456', GIT_SHA: 'other' },
      noGit,
    ),
    'abc123def456',
  );
  assert.equal(
    buildVersion({ GIT_SHA: 'fedcba987654' }, noGit),
    'fedcba987654',
  );
});

test('blank values are ignored, then git, then a timestamp', () => {
  assert.equal(
    buildVersion({ TIPME_BUILD_VERSION: '', GIT_SHA: ' ' }, () => 'gitsha\n'),
    'gitsha',
  );
  assert.match(buildVersion({}, noGit), /^\d{13}$/);
});

test('Vercel variables no longer decide the version', () => {
  assert.equal(
    buildVersion(
      { VERCEL_DEPLOYMENT_ID: 'dpl_x', VERCEL_GIT_COMMIT_SHA: 'vercel' },
      () => 'fromgit',
    ),
    'fromgit',
  );
});
