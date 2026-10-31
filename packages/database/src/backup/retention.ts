// The retention coordinator's decisions (WAL retention design, 31 October 2026). A pure function:
// given what is on disk and in the backup record, it says which backups are kept, which files can
// go and why, and what blocks pruning. It never deletes anything; the caller applies a plan only
// in apply mode and only when nothing blocks it.
//
// Rules that make it safe:
// - A marker (.backup file) never proves a backup exists: only a base backup file that is
//   recorded, decrypts with a valid tag, and is matched to its marker is a recovery point.
// - WAL is pruned only before the start of the oldest kept recovery point, never by age.
// - The newest verified backup is always kept, so the sole recoverable backup never goes.
// - Every kept recovery point needs unbroken WAL to the newest archived segment, followed
//   across timeline switches; a gap blocks pruning.
// - History files and in-progress copies (.tmp) are never candidates.

/** Segments per log file with Postgres's default 16 MB segments (the only size TipMe uses). */
const SEGMENTS_PER_LOG = 256;
const DEFAULT_LABEL = 'pg_basebackup base backup';
/** A backup's marker starts within this long after its file's timestamp (legacy, unlabelled). */
const TIME_MATCH_MS = 300_000;

const SEGMENT = /^([0-9A-F]{8})([0-9A-F]{8})([0-9A-F]{8})$/;
const PARTIAL = /^([0-9A-F]{24})\.partial$/;
const MARKER = /^([0-9A-F]{24})\.[0-9A-F]{8}\.backup$/;
const HISTORY = /^[0-9A-F]{8}\.history$/;

export interface BaseBackupFile {
  file: string;
  bytes: number;
  /** From the file name: when the backup was started. */
  takenAt: Date;
  /** In the database's backup record. */
  recorded: boolean;
  /** Decrypts with a valid authentication tag. */
  intact: boolean;
}

export interface BackupMarker {
  startSegment: string;
  startTime: Date;
  label: string;
  timeline: number;
}

export interface TimelineSwitch {
  parent: number;
  /** The parent timeline's segment holding the switch point. */
  switchSegment: string;
}

export interface RetentionPolicy {
  /** Keep recovery points taken in the last N days (staging). */
  keepDays?: number;
  /** Or keep the newest N (the behaviour before this change). */
  keepCount?: number;
  /** Never keep fewer than this many verified recovery points, when there are that many. */
  minKeep: number;
  /** Pruning needs a passing recovery drill at most this old. */
  drillMaxAgeDays: number;
}

export interface RetentionInput {
  now: Date;
  policy: RetentionPolicy;
  bases: BaseBackupFile[];
  partialBases: { file: string; bytes: number }[];
  /** Everything in the WAL archive. */
  wal: { name: string; bytes: number }[];
  /** Parsed contents of each marker, by file name. */
  markers: Record<string, BackupMarker>;
  /** Parsed contents of each timeline's history file, by timeline. */
  histories: Record<number, TimelineSwitch[]>;
  /** pg_stat_archiver.last_archived_wal. */
  lastArchived: string | null;
  /** A base backup is in progress (pg_stat_progress_basebackup, or a fresh .partial). */
  activeBackup: boolean;
  lastDrillPassAt: Date | null;
}

export type BackupStatus = 'retained' | 'expired' | 'unverified' | 'unanchored';

export interface RetentionPlan {
  backups: {
    file: string;
    status: BackupStatus;
    match: 'label' | 'time' | null;
    startSegment: string | null;
    reason: string;
  }[];
  /** The oldest kept recovery point's first WAL segment; nothing at or after it is touched. */
  boundary: string | null;
  candidates: {
    name: string;
    kind: 'wal' | 'partial-wal' | 'marker' | 'base' | 'partial-base';
    bytes: number;
    reason: string;
  }[];
  candidateBytes: number;
  archiveBytes: number;
  /** Reasons an applied run must not delete anything. */
  blocked: string[];
  warnings: string[];
}

/** Segment position across logs, ignoring the timeline (positions only grow across timelines). */
function position(segment: string): number {
  const m = SEGMENT.exec(segment.slice(0, 24));
  if (!m) return Number.NaN;
  return parseInt(m[2]!, 16) * SEGMENTS_PER_LOG + parseInt(m[3]!, 16);
}

const timelineOf = (segment: string) => parseInt(segment.slice(0, 8), 16);

function segmentName(timeline: number, pos: number): string {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(8, '0');
  return `${hex(timeline)}${hex(Math.floor(pos / SEGMENTS_PER_LOG))}${hex(pos % SEGMENTS_PER_LOG)}`;
}

/** The segment holding an LSN such as `6/9E000028`. */
function segmentOfLsn(timeline: number, lsn: string): string | null {
  const m = /^([0-9A-F]+)\/([0-9A-F]+)$/i.exec(lsn.trim());
  if (!m) return null;
  const high = parseInt(m[1]!, 16);
  const low = parseInt(m[2]!, 16);
  return segmentName(
    timeline,
    high * SEGMENTS_PER_LOG + Math.floor(low / 0x1000000),
  );
}

/** A `.backup` marker's contents; null when it isn't one. */
export function parseBackupMarker(text: string): BackupMarker | null {
  const field = (name: string) =>
    new RegExp(`^${name}: (.+)$`, 'm').exec(text)?.[1]?.trim();
  const start = /\(file ([0-9A-F]{24})\)/.exec(
    field('START WAL LOCATION') ?? '',
  )?.[1];
  const time = field('START TIME');
  const timeline = Number(field('START TIMELINE'));
  if (!start || !time || !Number.isInteger(timeline)) return null;
  const startTime = new Date(time.replace(' UTC', 'Z').replace(' ', 'T'));
  if (Number.isNaN(startTime.getTime())) return null;
  return {
    startSegment: start,
    startTime,
    label: field('LABEL') ?? '',
    timeline,
  };
}

/** A timeline's history file: one line per ancestor, `parent<TAB>switchLSN<TAB>reason`. */
export function parseTimelineHistory(text: string): TimelineSwitch[] {
  const out: TimelineSwitch[] = [];
  for (const line of text.split('\n')) {
    const [parent, lsn] = line.trim().split(/\s+/);
    if (!parent || !lsn || line.trim().startsWith('#')) continue;
    const tli = Number(parent);
    const switchSegment = segmentOfLsn(tli, lsn);
    if (Number.isInteger(tli) && switchSegment)
      out.push({ parent: tli, switchSegment });
  }
  return out;
}

export function planRetention(input: RetentionInput): RetentionPlan {
  const blocked: string[] = [];
  const warnings: string[] = [];
  const archiveBytes = input.wal.reduce((n, f) => n + f.bytes, 0);

  // Match each backup file to its marker: by label (new backups), or by start time (older ones).
  const markerEntries = Object.entries(input.markers);
  const used = new Set<string>();
  const matched = new Map<string, { marker: string; how: 'label' | 'time' }>();
  for (const base of input.bases) {
    const byLabel = markerEntries.find(([, m]) => m.label === base.file);
    if (byLabel) {
      matched.set(base.file, { marker: byLabel[0], how: 'label' });
      used.add(byLabel[0]);
    }
  }
  for (const base of input.bases) {
    if (matched.has(base.file)) continue;
    const byTime = markerEntries
      .filter(([name, m]) => {
        const after = m.startTime.getTime() - base.takenAt.getTime();
        return (
          !used.has(name) &&
          m.label === DEFAULT_LABEL &&
          after >= -1000 &&
          after <= TIME_MATCH_MS
        );
      })
      .sort((a, b) => a[1].startTime.getTime() - b[1].startTime.getTime())[0];
    if (byTime) {
      matched.set(base.file, { marker: byTime[0], how: 'time' });
      used.add(byTime[0]);
    }
  }
  for (const [name] of markerEntries)
    if (!used.has(name))
      warnings.push(
        `marker ${name} has no backup file: it is not a recovery point`,
      );

  // Recovery points: verified backups with a known WAL start, newest first.
  const anchors = input.bases
    .filter((b) => b.intact && b.recorded && matched.has(b.file))
    .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime());
  const keep = new Set<string>();
  const { keepDays, keepCount, minKeep } = input.policy;
  const windowStart =
    keepDays !== undefined ? input.now.getTime() - keepDays * 86_400_000 : null;
  anchors.forEach((b, i) => {
    const inWindow =
      windowStart !== null
        ? b.takenAt.getTime() >= windowStart
        : i < (keepCount ?? anchors.length);
    if (inWindow || i < Math.max(1, minKeep)) keep.add(b.file);
  });
  // The window's first hours need the newest recovery point from before it.
  if (windowStart !== null) {
    const covering = anchors.find((b) => b.takenAt.getTime() <= windowStart);
    if (covering) keep.add(covering.file);
  }

  const startOf = (file: string) =>
    input.markers[matched.get(file)!.marker]!.startSegment;
  const kept = anchors.filter((b) => keep.has(b.file));
  const oldestKept = kept.at(-1);
  const boundary = oldestKept ? startOf(oldestKept.file) : null;
  const boundaryPos = boundary ? position(boundary) : Number.NaN;

  if (input.activeBackup) blocked.push('a base backup is running');
  if (!oldestKept)
    blocked.push(
      'no verified backup with a known WAL start: nothing is recoverable to keep',
    );
  if (!input.lastDrillPassAt)
    blocked.push('no passing recovery drill on record');
  else if (
    input.now.getTime() - input.lastDrillPassAt.getTime() >
    input.policy.drillMaxAgeDays * 86_400_000
  )
    blocked.push(
      `no passing recovery drill in the last ${input.policy.drillMaxAgeDays} days`,
    );

  // Continuity: every kept recovery point needs each segment from its start to the newest one.
  const present = new Set(input.wal.map((f) => f.name));
  if (!input.lastArchived)
    blocked.push('the archiver has not archived any segment yet');
  else if (!present.has(input.lastArchived))
    blocked.push(
      `the newest archived segment ${input.lastArchived} is not in the archive`,
    );
  else if (boundary) {
    // The timeline path ending at the newest timeline: which timeline each position is on.
    const newest = timelineOf(input.lastArchived);
    const path = (input.histories[newest] ?? [])
      .map((s) => ({ timeline: s.parent, until: position(s.switchSegment) }))
      .sort((a, b) => a.until - b.until);
    const timelinesAt = (pos: number) => {
      const owners = path.filter((p) => pos <= p.until).map((p) => p.timeline);
      const first = owners[0] ?? newest;
      // The switch segment exists on both the parent and the child timeline.
      const next = path.find((p) => p.timeline === first);
      const child =
        next && pos === next.until
          ? (path[path.indexOf(next) + 1]?.timeline ?? newest)
          : null;
      return child === null ? [first] : [first, child];
    };
    const last = position(input.lastArchived);
    for (let pos = boundaryPos; pos <= last; pos++) {
      const options = timelinesAt(pos);
      if (!options.some((t) => present.has(segmentName(t, pos)))) {
        const missing = segmentName(options[0]!, pos);
        blocked.push(
          `WAL gap: ${missing} is missing, so kept backups can't be restored past it`,
        );
        break;
      }
    }
  }

  // What could go: only what lies before the boundary, and only backups that are not kept.
  const candidates: RetentionPlan['candidates'] = [];
  const newestIntact = input.bases
    .filter((b) => b.intact)
    .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())[0];
  const backups: RetentionPlan['backups'] = input.bases
    .slice()
    .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())
    .map((b) => {
      const m = matched.get(b.file);
      const startSegment = m ? input.markers[m.marker]!.startSegment : null;
      let status: BackupStatus;
      let reason: string;
      if (keep.has(b.file)) {
        status = 'retained';
        reason = 'within the retention policy';
      } else if (!b.intact || !b.recorded) {
        status = 'unverified';
        reason = !b.intact
          ? 'fails its integrity check'
          : 'not in the backup record';
      } else if (!m) {
        status = 'unanchored';
        reason = 'no marker: its WAL start is unknown';
      } else {
        status = 'expired';
        reason = 'older than the retention policy';
      }
      return {
        file: b.file,
        status,
        match: m?.how ?? null,
        startSegment,
        reason,
      };
    });

  if (oldestKept) {
    for (const b of backups) {
      const base = input.bases.find((x) => x.file === b.file)!;
      // Only backups older than the oldest kept one, and never the newest intact file.
      if (
        b.status === 'retained' ||
        base.takenAt.getTime() >= oldestKept.takenAt.getTime() ||
        base === newestIntact
      )
        continue;
      candidates.push({
        name: b.file,
        kind: 'base',
        bytes: base.bytes,
        reason: `backup ${b.reason}`,
      });
    }
    for (const f of input.wal) {
      const seg = SEGMENT.exec(f.name);
      const partial = PARTIAL.exec(f.name);
      const markerName = MARKER.exec(f.name);
      if (HISTORY.test(f.name) || f.name.endsWith('.tmp')) continue;
      const pos = position(
        seg ? f.name : (partial?.[1] ?? markerName?.[1] ?? ''),
      );
      if (Number.isNaN(pos) || pos >= boundaryPos) continue;
      if (markerName) {
        if (
          used.has(f.name) &&
          kept.some((k) => matched.get(k.file)?.marker === f.name)
        )
          continue;
        candidates.push({
          name: f.name,
          kind: 'marker',
          bytes: f.bytes,
          reason: used.has(f.name)
            ? 'marker of a backup outside the retention policy'
            : 'marker with no backup file',
        });
        continue;
      }
      candidates.push({
        name: f.name,
        kind: partial ? 'partial-wal' : 'wal',
        bytes: f.bytes,
        reason: `before the start of ${oldestKept.file} (${boundary}), the oldest kept backup`,
      });
    }
  }
  if (!input.activeBackup)
    for (const p of input.partialBases)
      candidates.push({
        name: p.file,
        kind: 'partial-base',
        bytes: p.bytes,
        reason: 'interrupted backup: never completed',
      });

  return {
    backups,
    boundary,
    candidates,
    candidateBytes: candidates.reduce((n, c) => n + c.bytes, 0),
    archiveBytes,
    blocked,
    warnings,
  };
}
