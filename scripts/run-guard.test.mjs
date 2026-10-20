import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const grant = (env) =>
  spawnSync(
    process.execPath,
    [
      'packages/database/dist/scripts/grant-owner.js',
      '--phone',
      '+2348035550101',
    ],
    {
      env: { PATH: process.env.PATH, ...env },
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
const REMOTE = 'postgres://tipme:secret@postgres:5432/tipme';

test('maintenance commands refuse a non-local database unless it is named (PR-010)', () => {
  const refused = grant({ DATABASE_URL: REMOTE });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /TIPME_CONFIRM_DATABASE/);
  assert.equal(refused.stderr.includes('secret'), false);
  const wrong = grant({
    DATABASE_URL: REMOTE,
    TIPME_CONFIRM_DATABASE: 'tipme_prod',
  });
  assert.equal(wrong.status, 1);
});

test('fix (final review): naming the database unlocks only the grant command, never seed or plain migrate', () => {
  for (const script of ['seed.js', 'migrate.js']) {
    const result = spawnSync(
      process.execPath,
      [`packages/database/dist/scripts/${script}`],
      {
        env: {
          PATH: process.env.PATH,
          DATABASE_URL: REMOTE,
          TIPME_CONFIRM_DATABASE: 'tipme',
        },
        encoding: 'utf8',
        timeout: 10_000,
      },
    );
    assert.equal(result.status, 1, script);
    assert.match(result.stderr, /non-local/, script);
  }
});
