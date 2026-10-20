#!/bin/sh
# Backup container (PR-010): a backup whenever none exists for the current UTC day (checked hourly),
# so one a day. `once` takes a single backup and exits (used by deploy.sh before migrating).
set -eu
export BACKUP_DIR=/backups
backup() { node packages/database/dist/scripts/backup.js; }
if [ "${1:-}" = "once" ]; then backup; exit $?; fi
while true; do
  today=$(date -u +%Y%m%d)
  if ! ls /backups/tipme-"$today"T*.dump.enc >/dev/null 2>&1; then backup || echo "backup failed; retrying in an hour"; fi
  sleep 3600
done
