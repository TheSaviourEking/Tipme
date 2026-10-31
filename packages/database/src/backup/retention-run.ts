import { createDecipheriv } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseBackupMarker,
  parseTimelineHistory,
  planRetention,
  type BackupMarker,
  type RetentionPlan,
  type RetentionPolicy,
  type TimelineSwitch,
} from './retention.js';

// The retention coordinator's run (see retention.ts for its rules): read the backup folder and
// the WAL archive, check each base backup decrypts, plan, report, and delete only in apply mode
// with nothing blocking it. One run at a time (a lock file in the backup folder).

const MAGIC = Buffer.from('TIPMEBK1');
const LOCK = '.retention.lock';
/** A lock this old (wall clock) belonged to a run that died. */
const STALE_LOCK_MS = 3_600_000;
/** A .partial base backup this recent may still be being written. */
const FRESH_PARTIAL_MS = 2 * 3_600_000;

export interface RetentionFacts {
  /** Base backup files in the database's backup record. */
  recordedFiles: string[];
  /** pg_stat_progress_basebackup has a row. */
  activeBackup: boolean;
  /** pg_stat_archiver.last_archived_wal. */
  lastArchived: string | null;
  lastDrillPassAt: Date | null;
}

export interface RetentionRun {
  outcome: 'planned' | 'applied' | 'blocked' | 'busy';
  plan: RetentionPlan;
  deletedBytes: number;
  disk: { freeBytes: number; totalBytes: number };
  /** Human-readable, one line per file; never contains a key or a URL. */
  report: string;
}

/** Whether a TipMe-encrypted file decrypts with a valid tag. Streams; writes nothing. */
export async function verifyEncryptedFile(
  path: string,
  keyBase64: string,
): Promise<boolean> {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) return false;
  const size = (await stat(path)).size;
  const header = MAGIC.length + 12;
  if (size < header + 16) return false;
  const handle = await open(path, 'r');
  try {
    const head = Buffer.alloc(header);
    await handle.read(head, 0, header, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) return false;
    const tag = Buffer.alloc(16);
    await handle.read(tag, 0, 16, size - 16);
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      head.subarray(MAGIC.length),
    );
    decipher.setAuthTag(tag);
    if (size - 16 > header) {
      const body = createReadStream(path, { start: header, end: size - 17 });
      for await (const chunk of body) decipher.update(chunk as Buffer);
    }
    decipher.final();
    return true;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

const STAMP = /^tipme-base-(\d{8})T(\d{6})Z-.*\.tar\.enc$/;
function takenAtOf(file: string): Date | null {
  const m = STAMP.exec(file);
  if (!m) return null;
  const [d, t] = [m[1]!, m[2]!];
  return new Date(
    `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4)}Z`,
  );
}

async function takeLock(dir: string): Promise<boolean> {
  const path = join(dir, LOCK);
  try {
    const handle = await open(path, 'wx');
    await handle.writeFile(`${process.pid} ${new Date().toISOString()}\n`);
    await handle.close();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const age = Date.now() - (await stat(path)).mtimeMs;
    if (age < STALE_LOCK_MS) return false;
    await rm(path, { force: true });
    return takeLock(dir);
  }
}

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

function render(
  plan: RetentionPlan,
  mode: 'dry-run' | 'apply',
  outcome: RetentionRun['outcome'],
  disk: RetentionRun['disk'],
): string {
  const lines = [
    `Backup retention ${mode === 'dry-run' ? 'DRY RUN (nothing deleted)' : 'APPLY'}: ${outcome}`,
    `Disk: ${gb(disk.freeBytes)} free of ${gb(disk.totalBytes)}. WAL archive: ${gb(plan.archiveBytes)}.`,
    `Recovery boundary: ${plan.boundary ?? 'none (no verified recovery point)'}`,
    'Base backups:',
    ...plan.backups.map(
      (b) =>
        `  ${b.status.padEnd(10)} ${b.file}  start ${b.startSegment ?? '?'} (${b.match ?? 'no marker'}): ${b.reason}`,
    ),
  ];
  if (plan.blocked.length)
    lines.push('BLOCKED:', ...plan.blocked.map((r) => `  - ${r}`));
  for (const w of plan.warnings) lines.push(`Warning: ${w}`);
  lines.push(
    `Candidates: ${plan.candidates.length} files, ${gb(plan.candidateBytes)}${mode === 'dry-run' ? ' (would be deleted)' : ''}`,
    ...plan.candidates.map(
      (c) => `  ${c.kind.padEnd(12)} ${c.name}  ${c.bytes} B  ${c.reason}`,
    ),
  );
  return lines.join('\n');
}

export async function runRetention(input: {
  now: Date;
  walDir: string;
  backupDir: string;
  key: string;
  mode: 'dry-run' | 'apply';
  policy: RetentionPolicy;
  facts: RetentionFacts;
}): Promise<RetentionRun> {
  const fs = await statfs(input.walDir);
  const disk = {
    freeBytes: Number(fs.bavail) * Number(fs.bsize),
    totalBytes: Number(fs.blocks) * Number(fs.bsize),
  };
  const empty: RetentionPlan = {
    backups: [],
    boundary: null,
    candidates: [],
    candidateBytes: 0,
    archiveBytes: 0,
    blocked: ['another retention run holds the lock'],
    warnings: [],
  };
  if (!(await takeLock(input.backupDir)))
    return {
      outcome: 'busy',
      plan: empty,
      deletedBytes: 0,
      disk,
      report: 'Backup retention: another run holds the lock; nothing done.',
    };
  try {
    const sized = async (dir: string, name: string) => ({
      name,
      bytes: (await stat(join(dir, name))).size,
    });
    const walNames = (await readdir(input.walDir)).filter((n) => n !== LOCK);
    const wal = await Promise.all(walNames.map((n) => sized(input.walDir, n)));
    const markers: Record<string, BackupMarker> = {};
    const histories: Record<number, TimelineSwitch[]> = {};
    for (const name of walNames) {
      if (/^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$/.test(name)) {
        const parsed = parseBackupMarker(
          await readFile(join(input.walDir, name), 'utf8'),
        );
        if (parsed) markers[name] = parsed;
      } else if (/^[0-9A-F]{8}\.history$/.test(name)) {
        histories[parseInt(name.slice(0, 8), 16)] = parseTimelineHistory(
          await readFile(join(input.walDir, name), 'utf8'),
        );
      }
    }

    const backupNames = await readdir(input.backupDir);
    const recorded = new Set(input.facts.recordedFiles);
    const bases = [];
    for (const file of backupNames) {
      const takenAt = takenAtOf(file);
      if (!takenAt) continue;
      const { bytes } = await sized(input.backupDir, file);
      bases.push({
        file,
        bytes,
        takenAt,
        recorded: recorded.has(file),
        intact: await verifyEncryptedFile(
          join(input.backupDir, file),
          input.key,
        ),
      });
    }
    const partialBases = [];
    let freshPartial = false;
    for (const file of backupNames.filter((f) =>
      /^tipme-base-.*\.tar\.enc\.partial$/.test(f),
    )) {
      const s = await stat(join(input.backupDir, file));
      if (Date.now() - s.mtimeMs < FRESH_PARTIAL_MS) freshPartial = true;
      partialBases.push({ file, bytes: s.size });
    }

    const plan = planRetention({
      now: input.now,
      policy: input.policy,
      bases,
      partialBases,
      wal,
      markers,
      histories,
      lastArchived: input.facts.lastArchived,
      activeBackup: input.facts.activeBackup || freshPartial,
      lastDrillPassAt: input.facts.lastDrillPassAt,
    });

    let deletedBytes = 0;
    let outcome: RetentionRun['outcome'] = 'planned';
    if (input.mode === 'apply') {
      if (plan.blocked.length) outcome = 'blocked';
      else {
        // Oldest first, so an interrupted run never leaves a hole in front of kept WAL.
        const ordered = plan.candidates
          .slice()
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const c of ordered) {
          const dir =
            c.kind === 'base' || c.kind === 'partial-base'
              ? input.backupDir
              : input.walDir;
          await rm(join(dir, c.name), { force: true });
          deletedBytes += c.bytes;
        }
        outcome = 'applied';
      }
    } else if (plan.blocked.length) outcome = 'planned';

    return {
      outcome,
      plan,
      deletedBytes,
      disk,
      report: render(plan, input.mode, outcome, disk),
    };
  } finally {
    await rm(join(input.backupDir, LOCK), { force: true });
  }
}
