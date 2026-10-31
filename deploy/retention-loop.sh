#!/bin/sh
# Retention service (WAL retention design, 31 Oct 2026): runs the coordinator every hour, a few
# minutes after the backup loop's hour, so a backup finishing now is recorded first. Dry run
# unless RETENTION_MODE=apply. A failed run is logged and retried next hour.
set -u
while true; do
  node packages/database/dist/scripts/backup-retention.js ||
    echo '{"event":"backup.retention.loop","message":"run failed; retrying in an hour"}'
  sleep 3600
done
