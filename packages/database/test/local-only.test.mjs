import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLocalDatabaseUrl } from '../dist/index.js';

test('only local database hosts are accepted, and errors never echo credentials', () => {
  assert.throws(
    () => assertLocalDatabaseUrl('postgres://u:secret@db.example.com/x'),
    (error) => {
      assert.match(error.message, /db\.example\.com/);
      assert.ok(!error.message.includes('secret'));
      return true;
    },
  );
  for (const url of [
    'postgres://u:p@localhost/x?host=db.example.com',
    'postgres://u:p@localhost/x?hostaddr=10.0.0.5',
    'postgresql:///x?host=/cloudsql/project:region:instance',
  ]) {
    assert.throws(() => assertLocalDatabaseUrl(url), /non-local|cannot/, url);
  }
  for (const url of [
    'postgres://u:p@localhost/x',
    'postgres://u:p@127.0.0.1:5432/x',
    'postgres://u:p@[::1]/x',
  ]) {
    assert.doesNotThrow(() => assertLocalDatabaseUrl(url));
  }
});

test('migrations refuse a remote database before connecting', () => {
  const script = fileURLToPath(
    new URL('../dist/scripts/migrate.js', import.meta.url),
  );
  const started = performance.now();
  const result = spawnSync(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: 'postgres://u:p@db.example.com/x',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-local database: db\.example\.com/);
  assert.ok(performance.now() - started < 2000);
});
