import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  parseBackupMarker,
  parseTimelineHistory,
  planRetention,
} from '../dist/backup/retention.js';

// The retention coordinator's decisions, from what is on disk and in the backup record. Nothing
// here touches a file: the plan is what a dry run reports and what an applied run would delete.

const MB16 = 16 * 1024 * 1024;
const hex = (n) => n.toString(16).toUpperCase().padStart(8, '0');
/** Segment number n (0-based across logs) on a timeline. */
const seg = (n, tli = 1) =>
  `${hex(tli)}${hex(Math.floor(n / 256))}${hex(n % 256)}`;
const marker = (n, tli = 1) => `${seg(n, tli)}.00000028.backup`;
const DAY = 86_400_000;
const NOW = new Date('2026-10-31T12:00:00Z');
const daysAgo = (d, extraMs = 0) => new Date(NOW.getTime() - d * DAY + extraMs);

/** One base backup a day for `days` days, starting at segment 300·k, each with its marker. */
function history(days, { label = 'file', segmentsPerDay = 300 } = {}) {
  const bases = [];
  const markers = {};
  const wal = [];
  for (let k = 0; k < days; k++) {
    const takenAt = daysAgo(days - 1 - k);
    const file = `tipme-base-${takenAt.toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z')}-abc.tar.enc`;
    bases.push({
      file,
      bytes: 50_000_000,
      takenAt,
      recorded: true,
      intact: true,
    });
    const start = k * segmentsPerDay + 5;
    markers[marker(start)] = {
      startSegment: seg(start),
      startTime: new Date(takenAt.getTime() + 2000),
      label: label === 'file' ? file : 'pg_basebackup base backup',
      timeline: 1,
    };
  }
  const last = days * segmentsPerDay;
  for (let n = 0; n <= last; n++) wal.push({ name: seg(n), bytes: MB16 });
  for (const name of Object.keys(markers)) wal.push({ name, bytes: 300 });
  return { bases, markers, wal, lastArchived: seg(last) };
}

const plan = (h, extra = {}) =>
  planRetention({
    now: NOW,
    policy: { keepDays: 3, minKeep: 2, drillMaxAgeDays: 7 },
    partialBases: [],
    histories: {},
    activeBackup: false,
    lastDrillPassAt: daysAgo(1),
    ...h,
    ...extra,
  });

test('parses a backup marker written by pg_basebackup', () => {
  const parsed = parseBackupMarker(
    [
      'START WAL LOCATION: 6/9E000028 (file 00000001000000060000009E)',
      'STOP WAL LOCATION: 6/9E000100 (file 00000001000000060000009E)',
      'BACKUP METHOD: streamed',
      'BACKUP FROM: primary',
      'START TIME: 2026-10-31 00:26:27 UTC',
      'LABEL: tipme-base-20261031T002627Z-45de550e4ce1.tar.enc',
      'START TIMELINE: 1',
      'STOP TIME: 2026-10-31 00:26:28 UTC',
      'STOP TIMELINE: 1',
    ].join('\n'),
  );
  assert.deepEqual(parsed, {
    startSegment: '00000001000000060000009E',
    startTime: new Date('2026-10-31T00:26:27Z'),
    label: 'tipme-base-20261031T002627Z-45de550e4ce1.tar.enc',
    timeline: 1,
  });
  assert.equal(parseBackupMarker('garbage'), null);
});

test('keeps every backup in the last three days and the WAL they need; everything before is a candidate, with a reason', () => {
  const h = history(7);
  const result = plan(h);
  assert.deepEqual(result.blocked, []);
  const kept = result.backups
    .filter((b) => b.status === 'retained')
    .map((b) => b.file);
  // Daily backups at 0, 1, 2 and 3 days ago: the one exactly 3 days ago covers the window's start.
  assert.equal(kept.length, 4);
  // The boundary is the oldest kept backup's start, never a file age.
  assert.equal(result.boundary, seg(3 * 300 + 5));
  const walGone = result.candidates.filter((c) => c.kind === 'wal');
  assert.equal(walGone.length, 3 * 300 + 5);
  assert.ok(walGone.every((c) => c.name < seg(3 * 300 + 5)));
  assert.ok(
    walGone.every((c) => /before the start of tipme-base-/.test(c.reason)),
  );
  assert.equal(
    result.candidates.filter((c) => c.kind === 'base').length,
    3,
    'the three older base backups',
  );
  assert.equal(
    result.candidateBytes,
    result.candidates.reduce((n, c) => n + c.bytes, 0),
  );
});

test('the whole window stays restorable: the newest backup from before it is kept too', () => {
  const h = history(7);
  // Backups an hour later each day: none sits exactly at the window's start (72 hours ago).
  for (const b of h.bases)
    b.takenAt = new Date(b.takenAt.getTime() + 3_600_000);
  for (const m of Object.values(h.markers))
    m.startTime = new Date(m.startTime.getTime() + 3_600_000);
  const result = plan(h);
  // In the window: 0, 1 and 2 days ago (+1 h), and the 3-days-ago one is 71 hours old. The
  // 4-days-ago one is kept as well, because without it 71 to 72 hours ago couldn't be restored.
  assert.equal(result.backups.filter((b) => b.status === 'retained').length, 5);
  assert.equal(result.boundary, seg(2 * 300 + 5));
});

test('a marker whose backup file is gone is an orphan: it never holds WAL back', () => {
  const h = history(7);
  // The production bug: the oldest backup file was pruned but its marker stayed.
  h.bases.shift();
  const result = plan(h);
  assert.deepEqual(result.blocked, []);
  assert.equal(result.boundary, seg(3 * 300 + 5));
  const orphan = result.candidates.find((c) => c.name === marker(5));
  assert.match(orphan.reason, /no backup file/);
  assert.ok(
    result.warnings.some((w) => /marker .* has no backup file/.test(w)),
  );
});

test('a marker never proves a backup: a missing, unrecorded or corrupt backup is not kept', () => {
  const h = history(4);
  h.bases[3].intact = false; // newest fails its integrity check
  h.bases[2].recorded = false; // not in the backup record
  const result = plan(h);
  const byFile = Object.fromEntries(
    result.backups.map((b) => [b.file, b.status]),
  );
  assert.equal(byFile[h.bases[3].file], 'unverified');
  assert.equal(byFile[h.bases[2].file], 'unverified');
  // The newest good one is kept, and minKeep keeps a second even though it is older than 3 days.
  assert.deepEqual(
    result.backups.filter((b) => b.status === 'retained').map((b) => b.file),
    [h.bases[1].file, h.bases[0].file],
  );
  // The corrupt newest file is never offered for deletion: it is newer than the boundary.
  assert.ok(!result.candidates.some((c) => c.name === h.bases[3].file));
});

test('with no verified backup at all, nothing is a candidate and pruning is blocked', () => {
  const h = history(3);
  for (const b of h.bases) b.intact = false;
  const result = plan(h);
  assert.equal(result.boundary, null);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.blocked.some((b) => /no verified backup/.test(b)));
});

test('the sole recoverable backup is never a candidate, however old', () => {
  const h = history(1);
  const old = plan(h, { now: new Date(NOW.getTime() + 30 * DAY) });
  assert.equal(old.backups[0].status, 'retained');
  assert.ok(!old.candidates.some((c) => c.kind === 'base'));
});

test('backups without their file label are matched to markers by start time, and say so', () => {
  const h = history(4, { label: 'default' });
  const result = plan(h);
  assert.ok(result.backups.every((b) => b.match === 'time'));
  assert.equal(result.boundary, seg(5));
});

test('an interrupted backup (.partial, nothing running) is a candidate; a running one blocks pruning', () => {
  const h = history(4);
  const partialBases = [
    {
      file: 'tipme-base-20261031T110000Z-abc.tar.enc.partial',
      bytes: 9_000_000,
    },
  ];
  const idle = plan(h, { partialBases });
  assert.ok(
    idle.candidates.some(
      (c) => c.kind === 'partial-base' && /interrupted/.test(c.reason),
    ),
  );
  const running = plan(h, { partialBases, activeBackup: true });
  assert.ok(running.blocked.some((b) => /base backup is running/.test(b)));
  assert.ok(!running.candidates.some((c) => c.kind === 'partial-base'));
});

test('a WAL gap after a kept backup blocks pruning and names the segment', () => {
  const h = history(4);
  const missing = seg(3 * 300 + 50);
  h.wal = h.wal.filter((w) => w.name !== missing);
  const result = plan(h);
  assert.ok(result.blocked.some((b) => b.includes(missing) && /gap/.test(b)));
});

test('a gap before the boundary does not matter: that WAL is not needed', () => {
  const h = history(7);
  h.wal = h.wal.filter((w) => w.name !== seg(100));
  assert.deepEqual(plan(h).blocked, []);
});

test('the newest archived segment must be in the archive', () => {
  const h = history(3);
  h.wal = h.wal.filter((w) => w.name !== h.lastArchived);
  assert.ok(plan(h).blocked.some((b) => /newest archived segment/.test(b)));
});

test('without a passing recovery drill in the last week, pruning is blocked (the report still lists candidates)', () => {
  const h = history(7);
  const stale = plan(h, { lastDrillPassAt: daysAgo(8) });
  assert.ok(stale.blocked.some((b) => /recovery drill/.test(b)));
  assert.ok(stale.candidates.length > 0);
  assert.ok(
    plan(h, { lastDrillPassAt: null }).blocked.some((b) =>
      /recovery drill/.test(b),
    ),
  );
});

test('timeline changes: history files are kept, and WAL is followed across the switch', () => {
  const h = history(4);
  // A restore promoted timeline 2 at segment 1000; later WAL is on timeline 2.
  const switchAt = 1000;
  // After the switch, timeline 1 stops: its later segments never existed.
  h.wal = h.wal.filter(
    (w) => !(/^00000001[0-9A-F]{16}$/.test(w.name) && w.name > seg(switchAt)),
  );
  for (let n = switchAt; n <= 1200; n++)
    h.wal.push({ name: seg(n, 2), bytes: MB16 });
  h.wal.push({ name: '00000002.history', bytes: 42 });
  h.lastArchived = seg(1200, 2);
  const histories = { 2: [{ parent: 1, switchSegment: seg(switchAt) }] };
  const result = plan(h, { histories });
  assert.deepEqual(result.blocked, []);
  assert.ok(!result.candidates.some((c) => c.name.endsWith('.history')));
  // A missing timeline-2 segment after the switch is a gap.
  const gap = plan(
    { ...h, wal: h.wal.filter((w) => w.name !== seg(1100, 2)) },
    { histories },
  );
  assert.ok(gap.blocked.some((b) => b.includes(seg(1100, 2))));
});

test('parses a timeline history file: each line is the parent timeline and where it ended', () => {
  // Segment 1000 on 16 MB segments is log 3, segment 0xE8: LSN 3/E8000000.
  assert.deepEqual(
    parseTimelineHistory('1\t3/E8000000\tno recovery target specified\n'),
    [{ parent: 1, switchSegment: seg(1000, 1) }],
  );
});

test('a count policy (the old production behaviour) keeps the newest N verified backups', () => {
  const h = history(9);
  const result = plan(h, {
    policy: { keepCount: 7, minKeep: 2, drillMaxAgeDays: 7 },
  });
  assert.equal(result.backups.filter((b) => b.status === 'retained').length, 7);
  assert.equal(result.boundary, seg(2 * 300 + 5));
});

test('in-progress archive copies (.tmp) and history files are never candidates', () => {
  const h = history(7);
  h.wal.push({ name: `${seg(1)}.tmp`, bytes: MB16 });
  const result = plan(h);
  assert.ok(!result.candidates.some((c) => c.name.endsWith('.tmp')));
});

test('a base backup is labelled with its own file name, so its marker names it', async () => {
  const { baseBackupArgs } = await import('../dist/backup/backup.js');
  const args = baseBackupArgs(
    'postgres://u@h/d',
    'tipme-base-20261031T002627Z-abc.tar.enc',
  );
  const at = args.indexOf('-l');
  assert.ok(at > 0);
  assert.equal(args[at + 1], 'tipme-base-20261031T002627Z-abc.tar.enc');
  // Still a self-contained tar to stdout with the WAL it needs.
  for (const flag of ['-Ft', '-X', 'fetch', '-D', '-'])
    assert.ok(args.includes(flag), flag);
});

test('a base backup run can leave pruning to the coordinator (retain 0 keeps every file)', async () => {
  const { pruneBaseBackups } = await import('../dist/backup/backup.js');
  const { mkdtempSync, writeFileSync, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'tipme-base-'));
  for (let d = 1; d <= 5; d++)
    writeFileSync(join(dir, `tipme-base-2026102${d}T000000Z-abc.tar.enc`), 'x');
  await pruneBaseBackups(dir, 0);
  assert.equal(readdirSync(dir).length, 5);
  await pruneBaseBackups(dir, 3);
  assert.equal(readdirSync(dir).length, 3);
});
