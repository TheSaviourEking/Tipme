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
