import { spawn } from 'node:child_process';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import type { Database } from '../client.js';
import { guarded } from '../operations/errors.js';

// Backups and the restore drill (PR-010). A backup is `pg_dump -Fc` taken from the same
// snapshot as its manifest (row counts, ledger totals, latest migration), encrypted with
// AES-256-GCM. The drill restores into a scratch database and proves the manifest matches.

const MAGIC = Buffer.from('TIPMEBK1');

export interface BackupManifest {
  file: string;
  createdAt: string;
  version: string;
  sha256: string;
  migration: string | null;
  counts: Record<string, number>;
  ledger: { currency: string; debit: string; credit: string }[];
}

/** A command prefix for running pg tools elsewhere (e.g. ['docker','exec','-i','pg']). */
export type PgExec = string[];

function keyOf(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_KEY must be 32 bytes, base64');
  return key;
}

const fileHash = async (path: string) => {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
};

/** What a database holds, read inside the caller's transaction (so it matches a snapshot). */
export async function readManifestFacts(
  client: pg.PoolClient | pg.Client,
): Promise<Pick<BackupManifest, 'migration' | 'counts' | 'ledger'>> {
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const counts: Record<string, number> = {};
  for (const { tablename } of tables.rows)
    counts[tablename] = Number(
      (
        await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM "${tablename.replace(/"/g, '')}"`,
        )
      ).rows[0]?.n ?? 0,
    );
  // A brand-new database (first deploy, backed up before its first migration) has no ledger yet.
  const hasLedger = Boolean(
    (
      await client.query<{ t: string | null }>(
        `SELECT to_regclass('public.ledger_entries') AS t`,
      )
    ).rows[0]?.t,
  );
  const ledger = hasLedger
    ? await client.query<{
        currency: string;
        debit: string;
        credit: string;
      }>(
        `SELECT currency,
            coalesce(sum(amount_minor) FILTER (WHERE side = 'debit'), 0)::text AS debit,
            coalesce(sum(amount_minor) FILTER (WHERE side = 'credit'), 0)::text AS credit
       FROM ledger_entries GROUP BY currency ORDER BY currency`,
      )
    : { rows: [] };
  // Checked, not caught: a failed query would abort the snapshot transaction.
  const hasMigrations = Boolean(
    (
      await client.query<{ t: string | null }>(
        `SELECT to_regclass('drizzle.__drizzle_migrations') AS t`,
      )
    ).rows[0]?.t,
  );
  const migration = hasMigrations
    ? ((
        await client.query<{ hash: string }>(
          `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`,
        )
      ).rows[0]?.hash ?? null)
    : null;
  return { migration, counts, ledger: ledger.rows };
}

function run(
  command: string[],
  options: {
    stdout?: NodeJS.WritableStream;
    stdin?: NodeJS.ReadableStream;
  } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const [bin, ...args] = command;
    const child = spawn(bin!, args, {
      stdio: [
        options.stdin ? 'pipe' : 'ignore',
        options.stdout ? 'pipe' : 'ignore',
        'pipe',
      ],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (options.stdin && child.stdin) options.stdin.pipe(child.stdin);
    if (options.stdout && child.stdout) child.stdout.pipe(options.stdout);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : // Tool messages can quote the connection string: keep only the first line, no URLs.
          reject(
            new Error(
              `${bin} failed (${code}): ${(stderr.split('\n')[0] ?? '').replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`,
            ),
          ),
    );
  });
}

/** Takes one encrypted backup and its manifest; keeps the newest `retain`. */
export async function createBackup(input: {
  url: string;
  key: string;
  dir: string;
  version: string;
  retain?: number;
  pgExec?: PgExec;
  now?: Date;
}): Promise<BackupManifest> {
  const key = keyOf(input.key);
  const stamp = (input.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, 'Z');
  const file = `tipme-${stamp}-${input.version.slice(0, 12)}.dump.enc`;
  const path = join(input.dir, file);
  const client = new pg.Client({ connectionString: input.url });
  await client.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const snapshot = (
      await client.query<{ s: string }>('SELECT pg_export_snapshot() AS s')
    ).rows[0]!.s;
    const facts = await readManifestFacts(client);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const out = createWriteStream(path, { mode: 0o600 });
    out.write(Buffer.concat([MAGIC, iv]));
    cipher.pipe(out, { end: false });
    const encrypted = new Promise<void>((resolve) =>
      cipher.once('end', resolve),
    );
    await run(
      [
        ...(input.pgExec ?? []),
        'pg_dump',
        '-Fc',
        `--snapshot=${snapshot}`,
        '-d',
        input.url,
      ],
      { stdout: cipher },
    );
    await encrypted;
    out.write(cipher.getAuthTag());
    await new Promise<void>((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
    await client.query('COMMIT');
    const manifest: BackupManifest = {
      file,
      createdAt: (input.now ?? new Date()).toISOString(),
      version: input.version,
      sha256: await fileHash(path),
      ...facts,
    };
    await writeFile(
      `${path.replace(/\.dump\.enc$/, '')}.manifest.json`,
      JSON.stringify(manifest, null, 2),
      {
        mode: 0o600,
      },
    );
    await recordBackupRun(client, {
      kind: 'logical',
      file,
      version: input.version,
    });
    await prune(input.dir, input.retain ?? 14);
    return manifest;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await rm(path, { force: true });
    throw error;
  } finally {
    await client.end();
  }
}

/** Keeps the newest `retain` backups (dump + manifest), oldest removed first. */
export async function prune(dir: string, retain: number): Promise<void> {
  const dumps = (await readdir(dir))
    .filter((f) => /^tipme-.*\.dump\.enc$/.test(f))
    .sort();
  for (const old of dumps.slice(0, Math.max(0, dumps.length - retain))) {
    await rm(join(dir, old), { force: true });
    await rm(join(dir, old.replace(/\.dump\.enc$/, '.manifest.json')), {
      force: true,
    });
  }
}

export async function latestBackup(dir: string): Promise<string | null> {
  const dumps = (await readdir(dir))
    .filter((f) => /^tipme-.*\.dump\.enc$/.test(f))
    .sort();
  return dumps.at(-1) ? join(dir, dumps.at(-1)!) : null;
}

async function decrypt(
  path: string,
  key: Buffer,
  target: string,
): Promise<void> {
  const size = (await stat(path)).size;
  const fd = await readFile(path);
  if (
    size < MAGIC.length + 12 + 16 ||
    !fd.subarray(0, MAGIC.length).equals(MAGIC)
  )
    throw new Error('not a TipMe backup');
  const iv = fd.subarray(MAGIC.length, MAGIC.length + 12);
  const tag = fd.subarray(size - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([
    decipher.update(fd.subarray(MAGIC.length + 12, size - 16)),
    decipher.final(),
  ]);
  await writeFile(target, plain, { mode: 0o600 });
}

/** What a restored database still lacks or contradicts against its manifest (empty = proved). */
async function compareWithManifest(
  url: string,
  manifest: BackupManifest,
): Promise<string[]> {
  const problems: string[] = [];
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const facts = await readManifestFacts(client);
    if (facts.migration !== manifest.migration)
      problems.push('latest migration differs');
    for (const [table, n] of Object.entries(manifest.counts))
      if (facts.counts[table] !== n)
        problems.push(
          `${table}: ${facts.counts[table] ?? 'missing'} rows, manifest says ${n}`,
        );
    if (JSON.stringify(facts.ledger) !== JSON.stringify(manifest.ledger))
      problems.push('ledger totals differ from the manifest');
    const unbalanced = await client.query<{ n: string }>(
      `SELECT count(*) AS n FROM (
           SELECT transaction_id FROM ledger_entries GROUP BY transaction_id, currency
           HAVING sum(CASE side WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0) x`,
    );
    if (Number(unbalanced.rows[0]?.n ?? 0) > 0)
      problems.push('some ledger transactions do not balance');
  } finally {
    await client.end();
  }
  return problems;
}

export interface DrillResult {
  ok: boolean;
  file: string;
  problems: string[];
}

/**
 * Restores a backup into a scratch database on the same server and proves it: the file is the one
 * the manifest describes, it decrypts with this key, and the restored rows, ledger totals and
 * latest migration equal the manifest; the books balance in every transaction.
 */
export async function restoreDrill(input: {
  url: string;
  key: string;
  file: string;
  scratchDatabase?: string;
  pgExec?: PgExec;
  tempDir?: string;
}): Promise<DrillResult> {
  const scratch = input.scratchDatabase ?? 'tipme_restore_drill';
  if (!/^[a-z0-9_]+_restore_drill$/.test(scratch))
    throw new Error('scratch database name must end with _restore_drill');
  const live = new URL(input.url);
  if (live.pathname.replace(/^\//, '') === scratch)
    throw new Error('scratch database must not be the live database');
  const problems: string[] = [];
  const manifestPath = input.file.replace(/\.dump\.enc$/, '.manifest.json');
  const manifest = JSON.parse(
    await readFile(manifestPath, 'utf8'),
  ) as BackupManifest;
  if ((await fileHash(input.file)) !== manifest.sha256)
    problems.push('the backup file does not match its manifest checksum');
  const plain = join(input.tempDir ?? '/tmp', `${scratch}-${process.pid}.dump`);
  try {
    await decrypt(input.file, keyOf(input.key), plain);
  } catch {
    return {
      ok: false,
      file: input.file,
      problems: [...problems, 'the backup cannot be decrypted with this key'],
    };
  }
  const admin = new pg.Client({ connectionString: input.url });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`);
    await admin.query(`CREATE DATABASE "${scratch}"`);
  } finally {
    await admin.end();
  }
  const scratchUrl = new URL(input.url);
  scratchUrl.pathname = `/${scratch}`;
  try {
    await run(
      [
        ...(input.pgExec ?? []),
        'pg_restore',
        '--no-owner',
        '--exit-on-error',
        '-d',
        scratchUrl.toString(),
      ],
      { stdin: createReadStream(plain) },
    );
    problems.push(
      ...(await compareWithManifest(scratchUrl.toString(), manifest)),
    );
  } catch (error) {
    problems.push((error as Error).message);
  } finally {
    await rm(plain, { force: true });
    const cleanup = new pg.Client({ connectionString: input.url });
    await cleanup.connect();
    await cleanup
      .query(`DROP DATABASE IF EXISTS "${scratch}"`)
      .catch(() => undefined);
    await cleanup.end();
  }
  return { ok: problems.length === 0, file: input.file, problems };
}

/**
 * A real restore (incident only): replaces the database in `url` with the backup. The database is
 * dropped and recreated first, so nothing a later migration added survives, then the result is
 * proved against the manifest. The operator must name the database (`confirmDatabase`).
 */
export async function restoreBackup(input: {
  url: string;
  key: string;
  file: string;
  confirmDatabase: string;
  pgExec?: PgExec;
  tempDir?: string;
}): Promise<DrillResult> {
  const target = new URL(input.url);
  const name = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (input.confirmDatabase !== name)
    throw new Error('Refusing to restore: confirm the target database by name');
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error('unexpected database name');
  const manifest = JSON.parse(
    await readFile(
      input.file.replace(/\.dump\.enc$/, '.manifest.json'),
      'utf8',
    ),
  ) as BackupManifest;
  if ((await fileHash(input.file)) !== manifest.sha256)
    return {
      ok: false,
      file: input.file,
      problems: ['the backup file does not match its manifest checksum'],
    };
  const plain = join(
    input.tempDir ?? '/tmp',
    `${name}-restore-${process.pid}.dump`,
  );
  try {
    await decrypt(input.file, keyOf(input.key), plain);
  } catch {
    return {
      ok: false,
      file: input.file,
      problems: ['the backup cannot be decrypted with this key'],
    };
  }
  try {
    const maintenance = new URL(input.url);
    maintenance.pathname = '/postgres';
    const admin = new pg.Client({ connectionString: maintenance.toString() });
    await admin.connect();
    try {
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [name],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      await admin.query(`CREATE DATABASE "${name}"`);
    } finally {
      await admin.end();
    }
    await run(
      [
        ...(input.pgExec ?? []),
        'pg_restore',
        '--no-owner',
        '--exit-on-error',
        '-d',
        input.url,
      ],
      { stdin: createReadStream(plain) },
    );
    const problems = await compareWithManifest(input.url, manifest);
    return { ok: problems.length === 0, file: input.file, problems };
  } finally {
    await rm(plain, { force: true });
  }
}

// ---- Point-in-time recovery (PR-011): base backups, WAL archive status, the backup record ----

/** Remembers a finished backup in the database it came from (read by /health/backups). */
async function recordBackupRun(
  client: pg.Client,
  input: { kind: 'logical' | 'base'; file: string; version: string },
): Promise<void> {
  const exists = (
    await client.query<{ t: string | null }>(
      `SELECT to_regclass('public.backup_runs') AS t`,
    )
  ).rows[0]?.t;
  // A brand-new database (first deploy) has no table yet; the next backup is recorded.
  if (!exists) return;
  await client.query(
    'INSERT INTO backup_runs (id, kind, file, version, finished_at) VALUES (gen_random_uuid(), $1, $2, $3, now())',
    [input.kind, input.file, input.version],
  );
}

/** Decrypts a TipMe backup file (dump or base backup) to `target` (mode 600). */
export async function decryptBackupFile(
  path: string,
  key: string,
  target: string,
): Promise<void> {
  await decrypt(path, keyOf(key), target);
}

/**
 * A physical base backup of the whole server (`pg_basebackup`, tar with the WAL it needs),
 * encrypted like the dumps. With the archived WAL it restores to any moment after it.
 */
export async function createBaseBackup(input: {
  url: string;
  key: string;
  dir: string;
  version: string;
  retain?: number;
  pgExec?: PgExec;
  now?: Date;
}): Promise<{ file: string }> {
  const key = keyOf(input.key);
  const stamp = (input.now ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, 'Z');
  const file = `tipme-base-${stamp}-${input.version.slice(0, 12)}.tar.enc`;
  // Written as .partial and renamed only once complete and on disk, so a killed run never
  // leaves a truncated file that looks like the newest backup (or counts towards those kept).
  for (const stale of await readdir(input.dir))
    if (/^tipme-base-.*\.tar\.enc\.partial$/.test(stale))
      await rm(join(input.dir, stale), { force: true });
  const path = join(input.dir, `${file}.partial`);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const out = createWriteStream(path, { mode: 0o600 });
  const written = new Promise<void>((resolve, reject) => {
    out.once('error', reject);
    out.once('finish', resolve);
  });
  out.write(Buffer.concat([MAGIC, iv]));
  cipher.pipe(out, { end: false });
  const encrypted = new Promise<void>((resolve) => cipher.once('end', resolve));
  try {
    await run(
      [
        ...(input.pgExec ?? []),
        'pg_basebackup',
        '-d',
        input.url,
        '-D',
        '-',
        '-Ft',
        '-X',
        'fetch',
        '--checkpoint=fast',
        '--no-password',
      ],
      { stdout: cipher },
    );
    await encrypted;
    out.end(cipher.getAuthTag());
    await written;
    const handle = await open(path, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(path, join(input.dir, file));
  } catch (error) {
    out.destroy();
    await rm(path, { force: true });
    throw error;
  }
  const client = new pg.Client({ connectionString: input.url });
  await client.connect();
  try {
    await recordBackupRun(client, {
      kind: 'base',
      file,
      version: input.version,
    });
  } finally {
    await client.end();
  }
  await pruneBaseBackups(input.dir, input.retain ?? 7);
  return { file };
}

/** Keeps the newest `retain` base backups. */
export async function pruneBaseBackups(
  dir: string,
  retain: number,
): Promise<void> {
  const bases = (await readdir(dir))
    .filter((f) => /^tipme-base-.*\.tar\.enc$/.test(f))
    .sort();
  for (const old of bases.slice(0, Math.max(0, bases.length - retain)))
    await rm(join(dir, old), { force: true });
}

export interface BackupStatus {
  logical: { at: string; file: string } | null;
  base: { at: string; file: string } | null;
  wal: {
    archiving: boolean;
    lastArchivedAt: string | null;
    lastFailedAt: string | null;
    failedCount: number;
  };
}

/** The newest backups and the WAL archiver's state, timestamps only (no secrets, no data). */
export async function backupStatus(db: Database): Promise<BackupStatus> {
  return guarded(async () => {
    const latest = async (kind: 'logical' | 'base') => {
      const rows = await db.execute<{ file: string; at: string }>(
        sql`SELECT file, finished_at AS at FROM backup_runs WHERE kind = ${kind} ORDER BY finished_at DESC LIMIT 1`,
      );
      const row = rows.rows[0];
      return row
        ? { file: row.file, at: new Date(String(row.at)).toISOString() }
        : null;
    };
    const wal = (
      await db.execute<{
        mode: string;
        last_archived_time: string | null;
        last_failed_time: string | null;
        failed_count: number;
      }>(sql`SELECT current_setting('archive_mode') AS mode, last_archived_time, last_failed_time,
                    failed_count::int AS failed_count FROM pg_stat_archiver`)
    ).rows[0];
    const iso = (value: string | null | undefined) =>
      value ? new Date(String(value)).toISOString() : null;
    return {
      logical: await latest('logical'),
      base: await latest('base'),
      wal: {
        archiving: wal?.mode === 'on' || wal?.mode === 'always',
        lastArchivedAt: iso(wal?.last_archived_time),
        lastFailedAt: iso(wal?.last_failed_time),
        failedCount: Number(wal?.failed_count ?? 0),
      },
    };
  });
}

/** Whether a backup of this kind is recorded for the current UTC day (false if not recorded). */
export function backedUpToday(
  db: Database,
  kind: 'logical' | 'base',
): Promise<boolean> {
  return guarded(async () => {
    const exists = (
      await db.execute<{ t: string | null }>(
        sql`SELECT to_regclass('public.backup_runs') AS t`,
      )
    ).rows[0]?.t;
    if (!exists) return false;
    const rows = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM backup_runs
       WHERE kind = ${kind} AND finished_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`);
    return Number(rows.rows[0]?.n ?? 0) > 0;
  });
}
