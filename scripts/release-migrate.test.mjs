import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const run = (env) =>
  spawnSync(
    process.execPath,
    ['packages/database/dist/scripts/release-migrate.js'],
    { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' },
  );
const URL = 'postgres://tipme:secret@db.internal:5432/tipme';

test('the release migration refuses without naming the target database', () => {
  const result = run({ DATABASE_URL: URL, MIGRATE_BACKUP_DONE: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /MIGRATE_CONFIRM_DATABASE/);
  assert.equal(result.stderr.includes('secret'), false, 'never prints the URL');
});

test('the release migration refuses a mismatched name', () => {
  const result = run({
    DATABASE_URL: URL,
    MIGRATE_CONFIRM_DATABASE: 'tipme_prod',
    MIGRATE_BACKUP_DONE: '1',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match/);
});

test('the release migration refuses without a backup first', () => {
  const result = run({ DATABASE_URL: URL, MIGRATE_CONFIRM_DATABASE: 'tipme' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /backup first/);
});
