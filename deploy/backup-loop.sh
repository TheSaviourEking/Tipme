#!/bin/sh
# Backup container (PR-010/011): hourly, a logical dump and a physical base backup whenever none is
# recorded for the current UTC day, so one of each a day. `once` takes a single backup and exits (used by deploy.sh before migrating).
set -eu
export BACKUP_DIR=/backups
backup() { node packages/database/dist/scripts/backup.js "$@"; }
# A physical base backup each day too: with the archived WAL it restores to any moment (PR-011).
base_backup() { node packages/database/dist/scripts/base-backup.js "$@"; }
if [ "${1:-}" = "once" ]; then backup; exit $?; fi
while true; do
  # "Done today" comes from the database's backup record, not from files on disk.
  backup --if-missing-today || echo "backup failed; retrying in an hour"
  base_backup --if-missing-today || echo "base backup failed; retrying in an hour"
  sleep 3600
done
