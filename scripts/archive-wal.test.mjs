import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// The real Postgres archive_command (deploy/postgres/archive-wal.sh) against temp folders.
const SCRIPT = resolve('deploy/postgres/archive-wal.sh');

function stage() {
  const home = mkdtempSync(join(tmpdir(), 'tipme-wal-'));
  const wal = join(home, 'wal');
  const bin = join(home, 'bin');
  mkdirSync(wal);
  mkdirSync(bin);
  // sync stand-in: records each call and whether the final segment already existed.
  writeFileSync(
    join(bin, 'sync'),
    `#!/bin/sh\nfor f in "$@"; do echo "$f $(test -f "$FINAL" && echo final-exists || echo final-missing)" >> "$SYNC_LOG"; done\n`,
  );
  chmodSync(join(bin, 'sync'), 0o755);
  const segment = (name, content) => {
    const path = join(home, name);
    writeFileSync(path, content);
    return path;
  };
  const archive = (src, name, extra = {}) =>
    spawnSync('sh', [SCRIPT, src, name], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        WAL_DIR: wal,
        FINAL: join(wal, name),
        SYNC_LOG: join(home, 'sync.log'),
        ...extra,
      },
      encoding: 'utf8',
    });
  const synced = () => {
    try {
      return readFileSync(join(home, 'sync.log'), 'utf8');
    } catch {
      return '';
    }
  };
  return { wal, segment, archive, synced };
}

test('a segment is archived, and flushed to disk before it gets its final name', () => {
  const { wal, segment, archive, synced } = stage();
  const result = archive(
    segment('seg', 'wal-bytes'),
    '000000010000000000000001',
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    readFileSync(join(wal, '000000010000000000000001'), 'utf8'),
    'wal-bytes',
  );
  assert.match(synced(), /000000010000000000000001\.tmp final-missing/);
});

test('retrying a segment already archived with the same bytes succeeds (no wedged archiver)', () => {
  const { segment, archive } = stage();
  const src = segment('seg', 'wal-bytes');
  assert.equal(archive(src, '000000010000000000000002').status, 0);
  const again = archive(src, '000000010000000000000002');
  assert.equal(again.status, 0, again.stderr);
});

test('a different segment under an archived name is refused and never overwrites it', () => {
  const { wal, segment, archive } = stage();
  assert.equal(
    archive(segment('a', 'first'), '000000010000000000000003').status,
    0,
  );
  const clash = archive(segment('b', 'other'), '000000010000000000000003');
  assert.notEqual(clash.status, 0);
  assert.equal(
    readFileSync(join(wal, '000000010000000000000003'), 'utf8'),
    'first',
  );
  assert.equal(existsSync(join(wal, '000000010000000000000003.tmp')), false);
});

const seg = (timeline, position) =>
  `${timeline}${position}`.toUpperCase().padStart(24, '0');

test('archiving never deletes anything: retention is the coordinator’s job, not archive_command’s', () => {
  const { wal, segment, archive } = stage();
  // Plenty of base backup markers and old WAL: the old script would have pruned here.
  const files = {
    [seg('00000001', '0000000000000005')]: 'old',
    [`${seg('00000001', '0000000000000010')}.00000028.backup`]: 'b1',
    [seg('00000001', '0000000000000015')]: 'old',
    [`${seg('00000001', '0000000000000020')}.00000028.backup`]: 'b2',
    [`${seg('00000001', '0000000000000030')}.00000028.backup`]: 'b3',
    '00000002.history': 'timeline',
  };
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(wal, name), body);
    utimesSync(join(wal, name), 0, 0);
  }
  const result = archive(
    segment('new', 'n'),
    seg('00000002', '0000000000000031'),
    { WAL_KEEP_BASE_BACKUPS: '1' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readdirSync(wal).sort(),
    [...Object.keys(files), seg('00000002', '0000000000000031')].sort(),
  );
});

test('the temporary legacy rule still prunes by marker count, only when switched on', () => {
  const { wal, segment, archive } = stage();
  const files = {
    [seg('00000001', '0000000000000005')]: 'old',
    [`${seg('00000001', '0000000000000010')}.00000028.backup`]: 'b1',
    [`${seg('00000001', '0000000000000020')}.00000028.backup`]: 'b2',
    [seg('00000001', '0000000000000025')]: 'keep',
    '00000002.history': 'timeline',
  };
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(wal, name), body);
  const result = archive(
    segment('n', 'n'),
    seg('00000001', '0000000000000026'),
    {
      WAL_LEGACY_PRUNE: 'on',
      WAL_KEEP_BASE_BACKUPS: '1',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    readdirSync(wal).sort(),
    [
      '00000002.history',
      `${seg('00000001', '0000000000000020')}.00000028.backup`,
      seg('00000001', '0000000000000025'),
      seg('00000001', '0000000000000026'),
    ].sort(),
  );
});
