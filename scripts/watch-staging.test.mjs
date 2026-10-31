import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateHealth } from './watch-staging.mjs';

const healthy = {
  ready: 200,
  web: 303,
  release: { kind: 'test', version: 'abc1234def00', paymentsLive: false },
  backups: {
    logical: { ageMinutes: 300 },
    base: { ageMinutes: 310 },
    wal: {
      archiving: true,
      lastArchivedAgeMinutes: 4,
      lastFailedAgeMinutes: null,
      failedCount: 0,
    },
    retention: {
      lastRunAgeMinutes: 20,
      mode: 'dry-run',
      outcome: 'planned',
      blocked: [],
      archiveBytes: 4_000_000_000,
      candidateBytes: 0,
      diskFreePercent: 55,
    },
  },
};
const problems = (patch) => evaluateHealth({ ...healthy, ...patch });

test('a healthy staging copy raises nothing', () => {
  assert.deepEqual(evaluateHealth(healthy), []);
});

test('each failure is named in plain words', () => {
  assert.match(problems({ ready: 503 })[0], /API is not ready/);
  assert.match(problems({ ready: 0 })[0], /API is not ready/);
  assert.match(problems({ web: 502 })[0], /web app/);
  assert.match(
    problems({ release: { ...healthy.release, paymentsLive: true } })[0],
    /LIVE payments/,
  );
  assert.match(
    problems({
      backups: { ...healthy.backups, logical: { ageMinutes: 27 * 60 } },
    })[0],
    /nightly backup/,
  );
  assert.match(
    problems({ backups: { ...healthy.backups, base: null } })[0],
    /base backup/,
  );
  assert.match(
    problems({
      backups: {
        ...healthy.backups,
        wal: { ...healthy.backups.wal, archiving: false },
      },
    })[0],
    /archiving is off/,
  );
  assert.match(
    problems({
      backups: {
        ...healthy.backups,
        wal: { ...healthy.backups.wal, lastArchivedAgeMinutes: 45 },
      },
    })[0],
    /15 minutes/,
  );
  assert.match(
    problems({
      backups: {
        ...healthy.backups,
        wal: {
          ...healthy.backups.wal,
          lastFailedAgeMinutes: 10,
          failedCount: 3,
        },
      },
    })[0],
    /failing/,
  );
});

test('an unreachable health endpoint is itself a problem, not a crash', () => {
  assert.match(problems({ release: null })[0], /release information/);
  assert.match(problems({ backups: null })[0], /backup health/);
});

const retention = (patch) =>
  problems({
    backups: {
      ...healthy.backups,
      retention: { ...healthy.backups.retention, ...patch },
    },
  });

test('backup retention: a coordinator that stopped running, or never ran, is named', () => {
  assert.match(
    retention({ lastRunAgeMinutes: 200 })[0],
    /retention .* 3 hours/,
  );
  assert.match(
    problems({ backups: { ...healthy.backups, retention: null } })[0],
    /retention .* never run/,
  );
});

test('backup retention: a disk filling up is named, with how much is left', () => {
  assert.match(retention({ diskFreePercent: 15 })[0], /disk .* 15% free/i);
  assert.deepEqual(retention({ diskFreePercent: 25 }), []);
});

test('backup retention: a broken recovery chain is named; the expected dry-run blockers are not', () => {
  assert.match(
    retention({ blocked: ['wal-gap'] })[0],
    /gap in the WAL archive/,
  );
  assert.match(
    retention({ blocked: ['no-verified-backup'] })[0],
    /no verified base backup/,
  );
  assert.match(
    retention({ blocked: ['archive-missing'] })[0],
    /newest WAL segment/,
  );
  // In a dry run, a missing drill or a running backup is expected and only blocks pruning.
  assert.deepEqual(retention({ blocked: ['no-drill', 'backup-running'] }), []);
  // When pruning is switched on, a missing drill stops it: that needs a person.
  assert.match(
    retention({ mode: 'apply', outcome: 'blocked', blocked: ['no-drill'] })[0],
    /recovery drill/,
  );
});
