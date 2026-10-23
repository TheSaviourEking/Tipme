#!/bin/sh
# Off-server copy (PR-011), run by the `offsite` service every 15 minutes: the encrypted backups
# to <remote>/backups and the WAL archive to <remote>/wal. The two copies are independent, so a
# problem with one never stops the other; files still being written are skipped; nothing on the
# remote is ever overwritten (--immutable).
#   offsite-loop.sh        loop forever
#   offsite-loop.sh once   one pass; exits non-zero if either copy failed
set -u
remote=${BACKUP_RCLONE_REMOTE:?set BACKUP_RCLONE_REMOTE}
backups=${BACKUP_DIR:-/backups}
wal=${WAL_DIR:-/wal}

pass() {
  failed=0
  rclone copy --immutable --exclude '*.tmp' --exclude '*.partial' "$backups" "$remote/backups" ||
    { echo "offsite: backups copy FAILED" >&2; failed=1; }
  rclone copy --immutable --exclude '*.tmp' "$wal" "$remote/wal" ||
    { echo "offsite: WAL copy FAILED" >&2; failed=1; }
  [ "$failed" = 0 ] && echo "offsite copy done"
  return "$failed"
}

if [ "${1:-}" = once ]; then
  pass
  exit $?
fi
while true; do
  pass || true
  sleep 900
done
