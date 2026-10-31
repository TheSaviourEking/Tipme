#!/usr/bin/env node
// Staging watcher (PR-011): checks a copy every 15 minutes from GitHub Actions and fails loudly.
//   node scripts/watch-staging.mjs --web <url> --api <url>
// A failed run emails the repository owner (GitHub notifications). If ALERT_WEBHOOK_URL is set,
// the problems are also posted there as {"text": "..."} (Slack-compatible incoming webhook).
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const DAY_AND_A_BIT = 26 * 60;

/** What is wrong with a staging snapshot, in plain words (empty = healthy). */
export function evaluateHealth(snapshot) {
  const problems = [];
  if (snapshot.ready !== 200)
    problems.push(
      `The API is not ready (HTTP ${snapshot.ready || 'no answer'}).`,
    );
  if (!snapshot.web || snapshot.web >= 500)
    problems.push(
      `The web app is not answering (HTTP ${snapshot.web || 'no answer'}).`,
    );
  const release = snapshot.release;
  if (!release) problems.push('The release information could not be read.');
  else if (release.paymentsLive)
    problems.push(
      'The copy reports LIVE payments: real money is not approved.',
    );
  const backups = snapshot.backups;
  if (!backups) {
    problems.push('The backup health could not be read.');
    return problems;
  }
  if (!backups.logical || backups.logical.ageMinutes > DAY_AND_A_BIT)
    problems.push('The nightly backup is missing or more than 26 hours old.');
  // Point-in-time recovery switched off on purpose (staging, 31 Oct 2026): the nightly dump is
  // the backup, so base backups, WAL and retention are not expected. Older APIs omit the field.
  if (backups.pointInTime === false) return problems;
  if (!backups.base || backups.base.ageMinutes > DAY_AND_A_BIT)
    problems.push(
      'The nightly base backup (for point-in-time recovery) is missing or more than 26 hours old.',
    );
  const wal = backups.wal;
  if (!wal.archiving)
    problems.push(
      'WAL archiving is off: point-in-time recovery is not possible.',
    );
  else {
    // Staging archives at least every 30 minutes (archive_timeout=1800): it's a test copy.
    if (wal.lastArchivedAgeMinutes === null || wal.lastArchivedAgeMinutes > 45)
      problems.push(
        'No WAL has been archived in the last 45 minutes: recent data is not protected.',
      );
    if (wal.lastFailedAgeMinutes !== null && wal.lastFailedAgeMinutes < 60)
      problems.push(
        `WAL archiving is failing (${wal.failedCount} failures, the last ${wal.lastFailedAgeMinutes} minutes ago).`,
      );
  }
  const retention = backups.retention;
  if (!retention) {
    problems.push(
      'Backup retention has never run: WAL growth is not being checked.',
    );
    return problems;
  }
  if (retention.lastRunAgeMinutes > 180)
    problems.push(
      `Backup retention has not run for over 3 hours (${retention.lastRunAgeMinutes} minutes).`,
    );
  if (retention.diskFreePercent < 20)
    problems.push(
      `The server disk is filling up: ${retention.diskFreePercent}% free. Check the WAL archive (${(retention.archiveBytes / 1024 ** 3).toFixed(1)} GB).`,
    );
  const blocked = new Set(retention.blocked);
  if (blocked.has('wal-gap'))
    problems.push(
      'There is a gap in the WAL archive: recent backups cannot be restored past it.',
    );
  if (blocked.has('no-verified-backup'))
    problems.push('There is no verified base backup to recover from.');
  if (blocked.has('archive-missing'))
    problems.push(
      'The newest WAL segment Postgres reports archived is missing from the archive.',
    );
  if (retention.mode === 'apply' && blocked.has('no-drill'))
    problems.push(
      'WAL pruning is paused: no passing recovery drill in the last 7 days. Run pitr-drill.sh.',
    );
  return problems;
}

async function status(url) {
  try {
    return (
      await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      })
    ).status;
  } catch {
    return 0;
  }
}
async function data(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    return response.ok ? (await response.json()).data : null;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { web: { type: 'string' }, api: { type: 'string' } },
  });
  if (!values.web || !values.api) {
    console.error(
      'usage: node scripts/watch-staging.mjs --web <url> --api <url>',
    );
    process.exit(2);
  }
  const api = new URL(values.api).origin;
  const snapshot = {
    ready: await status(`${api}/health/ready`),
    web: await status(new URL(values.web).origin),
    release: await data(`${api}/health/release`),
    backups: await data(`${api}/health/backups`),
  };
  const problems = evaluateHealth(snapshot);
  if (problems.length === 0) {
    console.log(`Staging is healthy (version ${snapshot.release?.version}).`);
    process.exit(0);
  }
  const text = `TipMe staging needs attention:\n${problems.map((p) => `• ${p}`).join('\n')}`;
  console.error(text);
  if (process.env.ALERT_WEBHOOK_URL)
    await fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => undefined);
  process.exit(1);
}
