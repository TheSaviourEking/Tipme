#!/bin/sh
# Postgres archive_command (PR-011): copy each finished WAL segment to /wal, flushed to disk
# before it gets its final name, and never overwriting a different file. Postgres retries a
# segment after a crash, so one already archived with the same bytes counts as done.
set -eu
src=$1
name=$2
dir=${WAL_DIR:-/wal}
if [ -f "$dir/$name" ]; then
  cmp -s "$src" "$dir/$name"
  exit $?
fi
cp "$src" "$dir/$name.tmp"
sync "$dir/$name.tmp"
mv "$dir/$name.tmp" "$dir/$name"
sync "$dir"

# Retention is the coordinator's job (backup-retention.js, the `retention` service), which only
# prunes WAL that no verified backup needs. Nothing is deleted here unless WAL_LEGACY_PRUNE=on:
# the old marker-count rule, kept only so the archive can't fill the disk while the coordinator
# runs in dry-run mode. Turn it off when the coordinator is switched to apply.
if [ "${WAL_LEGACY_PRUNE:-off}" = on ]; then
  # Old rule: WAL older than the start of the Nth newest .backup marker (N = base backups kept,
  # plus one spare). Timeline .history files are always kept. Positions compare without the
  # timeline.
  keep=${WAL_KEEP_BASE_BACKUPS:-8}
  cutoff=$(ls "$dir" | grep -E '^[0-9A-F]{24}\.[0-9A-F]{8}\.backup$' |
    awk '{ print substr($0, 9, 16) }' | sort -r | sed -n "${keep}p")
  if [ -n "$cutoff" ]; then
    ls "$dir" | grep -E '^[0-9A-F]{24}(\.partial|\.[0-9A-F]{8}\.backup)?$' |
      awk -v cutoff="$cutoff" 'substr($0, 9, 16) < cutoff' |
      while read -r old; do rm -f "$dir/$old"; done
  fi
fi
