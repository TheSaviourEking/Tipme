import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  backupStatus,
  backedUpToday,
  createBackup,
  createBaseBackup,
  decryptBackupFile,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// Point-in-time recovery pieces (PR-011 T1): a physical base backup (pg_basebackup, encrypted)
// and a record of every backup run, read by /health/backups and the alerts.
const pgExec = (
  process.env.BACKUP_PG_EXEC ?? 'docker exec -i tipme-postgres-1'
).split(' ');
const key = randomBytes(32).toString('base64');

test('base backups and the backup record', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  const dir = await mkdtemp(join(tmpdir(), 'tipme-base-'));

  await t.test(
    'a logical backup is recorded, and the status says when',
    async () => {
      const before = await backupStatus(database.db);
      assert.equal(before.logical, null);
      await createBackup({
        url: database.url,
        key,
        dir,
        version: 'abc1234def',
        pgExec,
      });
      const status = await backupStatus(database.db);
      assert.match(status.logical.at, /^\d{4}-\d\d-\d\dT/);
      assert.match(
        status.logical.file,
        /^tipme-\d{8}T\d{6}Z-abc1234def\.dump\.enc$/,
      );
      assert.equal(status.base, null);
      assert.equal(typeof status.wal.archiving, 'boolean');
    },
  );

  await t.test(
    'a base backup is a whole encrypted copy of the server, recorded too',
    async () => {
      const result = await createBaseBackup({
        // The tool connects inside the database container (local), as the server's backup job does.
        url: database.url,
        key,
        dir,
        version: 'abc1234def',
        pgExec,
      });
      assert.match(
        result.file,
        /^tipme-base-\d{8}T\d{6}Z-abc1234def\.tar\.enc$/,
      );
      const raw = await readFile(join(dir, result.file));
      assert.equal(
        raw.includes(Buffer.from('PG_VERSION')),
        false,
        'encrypted at rest',
      );
      const plain = join(dir, 'base.tar');
      await decryptBackupFile(join(dir, result.file), key, plain);
      const tar = await readFile(plain);
      assert.ok(
        tar.includes(Buffer.from('PG_VERSION')),
        'a data directory archive',
      );
      assert.ok(
        tar.includes(Buffer.from('backup_label')),
        'restorable: carries its backup label',
      );
      const status = await backupStatus(database.db);
      assert.equal(status.base.file, result.file);
    },
  );

  await t.test(
    '"backed up today" comes from the record, so an unrecorded file does not count',
    async () => {
      const { writeFile } = await import('node:fs/promises');
      assert.equal(await backedUpToday(database.db, 'logical'), true);
      assert.equal(await backedUpToday(database.db, 'base'), true);
      await database.pool.query(
        `DELETE FROM backup_runs WHERE kind = 'logical'`,
      );
      await writeFile(
        join(dir, 'tipme-29991231T000000Z-unrecorded.dump.enc'),
        'x',
      );
      assert.equal(await backedUpToday(database.db, 'logical'), false);
    },
  );

  await t.test(
    'a base backup is written under a .partial name until complete, and a killed run leaves nothing behind',
    async () => {
      const { writeFile } = await import('node:fs/promises');
      const leftover = 'tipme-base-20260101T000000Z-killed.tar.enc.partial';
      await writeFile(join(dir, leftover), 'truncated');
      const listing = join(await mkdtemp(join(tmpdir(), 'tipme-ls-')), 'ls');
      // Runs just before pg_basebackup streams: what names exist while it is being written?
      const watching = [
        'sh',
        '-c',
        `sleep 0.3; ls "${dir}" > "${listing}"; exec "$@"`,
        'sh',
        ...pgExec,
      ];
      const result = await createBaseBackup({
        url: database.url,
        key,
        dir,
        version: 'partial123',
        pgExec: watching,
        now: new Date('2026-10-22T00:00:00Z'),
      });
      const during = (await readFile(listing, 'utf8')).split('\n');
      assert.ok(during.includes(`${result.file}.partial`), during.join(' '));
      assert.equal(during.includes(result.file), false);
      const after = await readdir(dir);
      assert.ok(after.includes(result.file));
      assert.equal(
        after.some((f) => f.endsWith('.partial')),
        false,
        'no partial files remain',
      );
    },
  );

  await t.test('only the newest base backups are kept', async () => {
    const { pruneBaseBackups } = await import('../../dist/index.js');
    const { writeFile } = await import('node:fs/promises');
    for (let i = 0; i < 4; i++)
      await writeFile(
        join(dir, `tipme-base-2026010${i}T000000Z-old.tar.enc`),
        'x',
      );
    await pruneBaseBackups(dir, 2);
    const left = (await readdir(dir))
      .filter((f) => f.startsWith('tipme-base-'))
      .sort();
    assert.equal(left.length, 2);
    assert.ok(left.at(-1).includes('abc1234def'));
    assert.ok(
      (await readdir(dir)).some((f) => f.endsWith('.dump.enc')),
      'logical dumps are untouched',
    );
  });
});
