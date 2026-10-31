import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  runRetention,
  verifyEncryptedFile,
} from '../dist/backup/retention-run.js';

// The coordinator against real folders and real encrypted backup files (no Postgres): what it
// reads, what it reports, and that it deletes only in apply mode with nothing blocking it.

const KEY = randomBytes(32).toString('base64');
const MB = 1024 * 1024;
const NOW = new Date('2026-10-31T12:00:00Z');
const DAY = 86_400_000;
const hex = (n) => n.toString(16).toUpperCase().padStart(8, '0');
const seg = (n, tli = 1) =>
  `${hex(tli)}${hex(Math.floor(n / 256))}${hex(n % 256)}`;

function encrypted(path, plain, key = KEY) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  writeFileSync(
    path,
    Buffer.concat([Buffer.from('TIPMEBK1'), iv, body, cipher.getAuthTag()]),
  );
}

/** A staging layout: `days` daily base backups, their markers, and WAL between them. */
function layout(days = 6, perDay = 20) {
  const home = mkdtempSync(join(tmpdir(), 'tipme-retention-'));
  const backups = join(home, 'backups');
  const wal = join(home, 'wal');
  mkdirSync(backups);
  mkdirSync(wal);
  const recorded = [];
  for (let k = 0; k < days; k++) {
    const takenAt = new Date(NOW.getTime() - (days - 1 - k) * DAY);
    const stamp = takenAt
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\..+/, 'Z');
    const file = `tipme-base-${stamp}-abc.tar.enc`;
    encrypted(join(backups, file), randomBytes(2048));
    recorded.push(file);
    const start = k * perDay + 2;
    const t = new Date(takenAt.getTime() + 2000)
      .toISOString()
      .replace('T', ' ')
      .replace(/\..+/, ' UTC');
    writeFileSync(
      join(wal, `${seg(start)}.00000028.backup`),
      [
        `START WAL LOCATION: 0/0 (file ${seg(start)})`,
        `START TIME: ${t}`,
        `LABEL: ${file}`,
        'START TIMELINE: 1',
      ].join('\n'),
    );
  }
  const last = days * perDay;
  for (let n = 0; n <= last; n++)
    writeFileSync(join(wal, seg(n)), Buffer.alloc(1024));
  return {
    home,
    backups,
    wal,
    facts: {
      recordedFiles: recorded,
      activeBackup: false,
      lastArchived: seg(last),
      lastDrillPassAt: new Date(NOW.getTime() - DAY),
    },
  };
}

const run = (l, extra = {}) =>
  runRetention({
    now: NOW,
    walDir: l.wal,
    backupDir: l.backups,
    key: KEY,
    mode: 'dry-run',
    policy: { keepDays: 3, minKeep: 2, drillMaxAgeDays: 7 },
    facts: l.facts,
    ...extra,
  });

test('an intact encrypted file verifies; a tampered one or the wrong key does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tipme-verify-'));
  const good = join(dir, 'good.tar.enc');
  encrypted(good, randomBytes(3 * MB));
  assert.equal(await verifyEncryptedFile(good, KEY), true);
  assert.equal(
    await verifyEncryptedFile(good, randomBytes(32).toString('base64')),
    false,
  );
  const bad = join(dir, 'bad.tar.enc');
  encrypted(bad, randomBytes(4096));
  const { readFileSync } = await import('node:fs');
  const bytes = readFileSync(bad);
  bytes[100] ^= 0xff;
  writeFileSync(bad, bytes);
  assert.equal(await verifyEncryptedFile(bad, KEY), false);
  writeFileSync(join(dir, 'short.tar.enc'), 'TIPME');
  assert.equal(
    await verifyEncryptedFile(join(dir, 'short.tar.enc'), KEY),
    false,
  );
});

test('a dry run reports every candidate with its size and reason, and deletes nothing', async () => {
  const l = layout();
  const before = readdirSync(l.wal).length + readdirSync(l.backups).length;
  const result = await run(l);
  assert.equal(result.outcome, 'planned');
  assert.equal(result.deletedBytes, 0);
  assert.ok(result.plan.candidates.length > 0);
  assert.ok(
    result.plan.candidates.every((c) => c.bytes > 0 && c.reason.length > 0),
  );
  assert.equal(
    readdirSync(l.wal).length + readdirSync(l.backups).length,
    before,
  );
  assert.ok(result.report.includes('DRY RUN'));
  assert.ok(result.report.includes(result.plan.candidates[0].name));
  assert.ok(!result.report.includes(KEY), 'the key never reaches the report');
});

test('apply deletes exactly the candidates and keeps every retained backup and the WAL it needs', async () => {
  const l = layout();
  const result = await run(l, { mode: 'apply' });
  assert.equal(result.outcome, 'applied');
  for (const c of result.plan.candidates) {
    const dir =
      c.kind === 'base' || c.kind === 'partial-base' ? l.backups : l.wal;
    assert.equal(existsSync(join(dir, c.name)), false, c.name);
  }
  for (const b of result.plan.backups.filter((x) => x.status === 'retained'))
    assert.ok(existsSync(join(l.backups, b.file)));
  const boundary = result.plan.boundary;
  assert.ok(
    readdirSync(l.wal)
      .filter((f) => /^[0-9A-F]{24}$/.test(f))
      .every((f) => f >= boundary),
  );
  // A second run finds nothing left to do.
  const again = await run(l, { mode: 'apply' });
  assert.equal(again.plan.candidates.length, 0);
});

test('apply deletes nothing when pruning is blocked: a WAL gap', async () => {
  const l = layout();
  const { rmSync } = await import('node:fs');
  rmSync(join(l.wal, seg(5 * 20 + 7)));
  const before = readdirSync(l.wal).length;
  const result = await run(l, { mode: 'apply' });
  assert.equal(result.outcome, 'blocked');
  assert.equal(readdirSync(l.wal).length, before);
  assert.ok(result.report.includes('BLOCKED'));
});

test('apply deletes nothing while a base backup is running', async () => {
  const l = layout();
  const before = readdirSync(l.wal).length;
  const result = await run(l, {
    mode: 'apply',
    facts: { ...l.facts, activeBackup: true },
  });
  assert.equal(result.outcome, 'blocked');
  assert.equal(readdirSync(l.wal).length, before);
});

test('a backup file that fails its integrity check is reported, never relied on', async () => {
  const l = layout();
  const newest = l.facts.recordedFiles.at(-1);
  writeFileSync(join(l.backups, newest), 'TIPMEBK1 not really');
  const result = await run(l);
  const status = result.plan.backups.find((b) => b.file === newest).status;
  assert.equal(status, 'unverified');
  assert.ok(result.plan.backups.some((b) => b.status === 'retained'));
});

test('two runs at once: the second finds the lock and does nothing', async () => {
  const l = layout();
  const [a, b] = await Promise.all([
    run(l, { mode: 'apply' }),
    run(l, { mode: 'apply' }),
  ]);
  const outcomes = [a.outcome, b.outcome].sort();
  assert.deepEqual(outcomes, ['applied', 'busy']);
});

test('a stale lock from a crashed run is taken over after an hour', async () => {
  const l = layout();
  const { utimesSync } = await import('node:fs');
  const lock = join(l.backups, '.retention.lock');
  writeFileSync(lock, 'crashed');
  // Lock age is wall-clock time, not the run's "now".
  const old = (Date.now() - 2 * 3_600_000) / 1000;
  utimesSync(lock, old, old);
  const result = await run(l);
  assert.equal(result.outcome, 'planned');
  assert.equal(existsSync(lock), false, 'released afterwards');
});

test('disk space and archive size are measured', async () => {
  const l = layout();
  const result = await run(l);
  assert.ok(result.disk.totalBytes > 0);
  assert.ok(result.disk.freeBytes > 0);
  assert.equal(result.plan.archiveBytes > 0, true);
});
