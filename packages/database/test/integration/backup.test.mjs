import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createBackup,
  createPaymentIntent,
  createQuote,
  prune,
  recordProviderEvent,
  restoreBackup,
  restoreDrill,
} from '../../dist/index.js';
import { useDatabase } from './helpers.mjs';

// The host has no Postgres tools; run them inside the local Postgres container, where the
// test database URL (127.0.0.1:5432) points at the same server.
const pgExec = (
  process.env.BACKUP_PG_EXEC ?? 'docker exec -i tipme-postgres-1'
).split(' ');
const key = randomBytes(32).toString('base64');

test('backups and the restore drill', async (t) => {
  const database = await useDatabase(t);
  await database.fresh();
  // A paid tip, so there are ledger rows to prove.
  const quote = await createQuote(database.db, {
    handle: 'ada',
    tipMinor: 100000n,
    currency: 'NGN',
  });
  const { attemptId } = await createPaymentIntent(database.db, {
    quoteId: quote.quoteId,
    idempotencyKey: randomUUID(),
  });
  const total = (
    await database.pool.query(
      'SELECT payer_total_minor AS t FROM tip_quotes WHERE id = $1',
      [quote.quoteId],
    )
  ).rows[0].t;
  await recordProviderEvent(database.db, {
    provider: 'mock',
    providerEventId: randomUUID(),
    eventType: 'payment.succeeded',
    attemptId,
    providerReference: `ref-${attemptId}`,
    amountMinor: BigInt(total),
    currency: 'NGN',
    providerFeeMinor: 1500n,
    signatureVerified: true,
    payload: { kind: 'test' },
  });
  const dir = await mkdtemp(join(tmpdir(), 'tipme-backup-'));

  await t.test(
    'a backup restores into a scratch database and matches its manifest',
    async () => {
      const manifest = await createBackup({
        url: database.url,
        key,
        dir,
        version: 'abc1234def',
        pgExec,
      });
      assert.match(manifest.file, /^tipme-\d{8}T\d{6}Z-abc1234def\.dump\.enc$/);
      assert.ok(manifest.counts.ledger_entries > 0);
      assert.ok(manifest.migration);
      const raw = await readFile(join(dir, manifest.file));
      assert.equal(
        raw.includes(Buffer.from('ledger_entries')),
        false,
        'the file is encrypted',
      );
      const result = await restoreDrill({
        url: database.url,
        key,
        file: join(dir, manifest.file),
        pgExec,
        tempDir: dir,
      });
      assert.deepEqual(result.problems, []);
      assert.equal(result.ok, true);
    },
  );

  await t.test(
    'a tampered manifest or the wrong key fails the drill (Review Focus 4)',
    async () => {
      const [file] = (await readdir(dir)).filter((f) =>
        f.endsWith('.dump.enc'),
      );
      const path = join(dir, file);
      const manifestPath = path.replace(/\.dump\.enc$/, '.manifest.json');
      const original = await readFile(manifestPath, 'utf8');
      const tampered = JSON.parse(original);
      tampered.counts.tips += 1;
      await writeFile(manifestPath, JSON.stringify(tampered));
      const counted = await restoreDrill({
        url: database.url,
        key,
        file: path,
        pgExec,
        tempDir: dir,
      });
      assert.equal(counted.ok, false);
      assert.ok(counted.problems.some((p) => p.startsWith('tips:')));
      await writeFile(manifestPath, original);
      const wrongKey = await restoreDrill({
        url: database.url,
        key: randomBytes(32).toString('base64'),
        file: path,
        pgExec,
        tempDir: dir,
      });
      assert.equal(wrongKey.ok, false);
      assert.ok(wrongKey.problems.some((p) => /decrypted/.test(p)));
    },
  );

  await t.test(
    'fix (final review): a real restore recreates the database from the backup, leaving nothing a later migration added',
    async () => {
      const [file] = (await readdir(dir)).filter((f) =>
        f.endsWith('.dump.enc'),
      );
      const target = 'tipme_restore_target_check';
      await database.pool.query(`DROP DATABASE IF EXISTS ${target}`);
      await database.pool.query(`CREATE DATABASE ${target}`);
      const url = new URL(database.url);
      url.pathname = `/${target}`;
      // Something a bad migration might have left behind; the restore must remove it.
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: url.toString() });
      await client.connect();
      await client.query('CREATE TABLE left_by_bad_migration (id int)');
      await client.end();
      await assert.rejects(
        restoreBackup({
          url: url.toString(),
          key,
          file: join(dir, file),
          confirmDatabase: 'tipme',
          pgExec,
          tempDir: dir,
        }),
        /confirm/,
      );
      const result = await restoreBackup({
        url: url.toString(),
        key,
        file: join(dir, file),
        confirmDatabase: target,
        pgExec,
        tempDir: dir,
      });
      assert.deepEqual(result.problems, []);
      const check = new pg.Client({ connectionString: url.toString() });
      await check.connect();
      const leftover = await check.query(
        `SELECT to_regclass('public.left_by_bad_migration') AS t`,
      );
      const tips = await check.query('SELECT count(*)::int AS n FROM tips');
      await check.end();
      assert.equal(leftover.rows[0].t, null);
      assert.ok(tips.rows[0].n >= 1);
      await database.pool.query(`DROP DATABASE IF EXISTS ${target}`);
    },
  );

  await t.test('only the newest backups are kept', async () => {
    for (let i = 0; i < 5; i++)
      await writeFile(join(dir, `tipme-2026010${i}T000000Z-old.dump.enc`), 'x');
    await prune(dir, 3);
    const left = (await readdir(dir))
      .filter((f) => f.endsWith('.dump.enc'))
      .sort();
    assert.equal(left.length, 3);
    assert.ok(
      left.at(-1).includes('abc1234def'),
      'the real backup is the newest and stays',
    );
  });

  await t.test(
    'a brand-new, empty database can be backed up (the first deploy backs up before migrating)',
    async () => {
      await database.pool.query(
        'DROP DATABASE IF EXISTS tipme_empty_backup_check',
      );
      await database.pool.query('CREATE DATABASE tipme_empty_backup_check');
      const url = new URL(database.url);
      url.pathname = '/tipme_empty_backup_check';
      try {
        const manifest = await createBackup({
          url: url.toString(),
          key,
          dir,
          version: 'empty00',
          pgExec,
        });
        assert.deepEqual(manifest.ledger, []);
        assert.equal(manifest.migration, null);
      } finally {
        await database.pool.query(
          'DROP DATABASE IF EXISTS tipme_empty_backup_check',
        );
      }
    },
  );

  await t.test(
    'the drill refuses to restore over the live database',
    async () => {
      const live = new URL(database.url).pathname.slice(1);
      await assert.rejects(
        restoreDrill({
          url: database.url,
          key,
          file: 'x',
          scratchDatabase: live,
        }),
      );
    },
  );
});
