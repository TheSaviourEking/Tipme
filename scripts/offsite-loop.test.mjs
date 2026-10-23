import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

// The off-server copy (deploy/scripts/offsite-loop.sh) with rclone replaced by a stand-in.
const SCRIPT = resolve('deploy/scripts/offsite-loop.sh');

function run({ failOn = '' } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'tipme-offsite-'));
  const bin = join(home, 'bin');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'rclone'),
    `#!/bin/sh\necho "$*" >> "$LOG"\ncase "$*" in *"$FAIL_ON"*) [ -n "$FAIL_ON" ] && exit 1 ;; esac\nexit 0\n`,
  );
  chmodSync(join(bin, 'rclone'), 0o755);
  const result = spawnSync('sh', [SCRIPT, 'once'], {
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      LOG: join(home, 'calls'),
      FAIL_ON: failOn,
      BACKUP_RCLONE_REMOTE: 'remote:tipme',
    },
    encoding: 'utf8',
  });
  let calls = [];
  try {
    calls = readFileSync(join(home, 'calls'), 'utf8').trim().split('\n');
  } catch {
    // no calls
  }
  return { ...result, calls };
}

test('backups and WAL are copied separately, never overwriting, skipping files still being written', () => {
  const { status, calls } = run();
  assert.equal(status, 0);
  assert.equal(calls.length, 2);
  const [backups, wal] = calls;
  assert.match(backups, /copy --immutable .*\/backups remote:tipme\/backups/);
  assert.match(wal, /copy --immutable .*\/wal remote:tipme\/wal/);
  for (const call of calls) assert.match(call, /--exclude \*\.tmp/);
  assert.match(backups, /--exclude \*\.partial/);
});

test('a failed backups copy still copies WAL, and the run reports the failure', () => {
  const { status, calls, stderr } = run({ failOn: '/backups ' });
  assert.notEqual(status, 0);
  assert.equal(calls.length, 2, 'WAL was still copied');
  assert.match(stderr, /backups copy FAILED/);
});
