#!/usr/bin/env bash
# Point-in-time recovery drill (PR-011, PRD §13: RPO ≤ 15 minutes). Needs only Docker.
#
#   1. takes a fresh base backup (or uses today's);
#   2. writes a marker row AFTER that backup and forces its WAL into the archive;
#   3. restores base backup + archived WAL into a throwaway Postgres container;
#   4. passes only if the marker came back and every ledger transaction balances.
#
# Nothing touches the live database except the marker row. On the server:
#   /srv/tipme/live/scripts/pitr-drill.sh
# Locally (the staging proof stack): TIPME_COMPOSE="docker compose -f ... --env-file ..." pitr-drill.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)

if [[ -n "${TIPME_COMPOSE:-}" ]]; then
  # shellcheck disable=SC2206
  compose_cmd=($TIPME_COMPOSE)
  compose() { "${compose_cmd[@]}" "$@"; }
else
  source "$here/lib.sh"
  version=$(current_version)
  [[ -n "$version" ]] || { echo "Nothing deployed yet." >&2; exit 2; }
  compose() { compose_for "$version" "$@"; }
fi

project=${TIPME_PROJECT:-tipme-staging}
scratch=tipme-pitr-drill
volume=tipme-pitr-drill
image=${POSTGRES_IMAGE:-postgres:16.13-alpine}
cleanup() {
  docker rm -f "$scratch" >/dev/null 2>&1 || true
  docker volume rm "$volume" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup

sql() { compose exec -T postgres psql -U tipme -d tipme -Atq -c "$1"; }

echo "==> Base backup"
compose run --rm backup node packages/database/dist/scripts/base-backup.js
base=$(compose run -T --rm backup sh -c 'ls /backups/tipme-base-*.tar.enc | sort | tail -n 1' | tr -d '\r')
[[ -n "$base" ]] || { echo "No base backup found." >&2; exit 1; }

echo "==> Marker written after the base backup, then archived"
marker=$(sql "INSERT INTO recovery_markers (id) VALUES (gen_random_uuid()) RETURNING id")
segment=$(sql "SELECT pg_walfile_name(pg_switch_wal())")
for _ in $(seq 1 60); do
  last=$(sql "SELECT coalesce(last_archived_wal, '') FROM pg_stat_archiver")
  [[ "$last" > "$segment" || "$last" == "$segment" ]] && break
  sleep 2
done
[[ "$last" > "$segment" || "$last" == "$segment" ]] || { echo "WAL $segment was not archived." >&2; exit 1; }

echo "==> Decrypting $(basename "$base")"
docker volume create "$volume" >/dev/null
compose run --rm -v "$volume:/out" --user root backup sh -c \
  "node packages/database/dist/scripts/decrypt-backup.js '$base' /out/base.tar && chmod 644 /out/base.tar"

echo "==> Restoring base backup + archived WAL into a throwaway server"
docker run -d --name "$scratch" -v "$volume:/restore" -v "${PITR_WAL_VOLUME:-${project}_walarchive}:/wal:ro" \
  -e POSTGRES_PASSWORD=drill --entrypoint sh "$image" -c '
    set -e
    export PGDATA=/var/lib/postgresql/data
    mkdir -p "$PGDATA" && tar -xf /restore/base.tar -C "$PGDATA"
    rm -f "$PGDATA"/postmaster.pid
    echo "restore_command = '"'"'cp /wal/%f %p'"'"'" >> "$PGDATA/postgresql.auto.conf"
    echo "recovery_target_action = '"'"'promote'"'"'" >> "$PGDATA/postgresql.auto.conf"
    touch "$PGDATA/recovery.signal"
    chown -R postgres:postgres "$PGDATA" && chmod 700 "$PGDATA"
    exec su-exec postgres postgres -c archive_mode=off -c hba_file="$PGDATA/pg_hba.conf"' >/dev/null

ready=""
for _ in $(seq 1 90); do
  if docker exec "$scratch" psql -U tipme -d tipme -Atq -c "SELECT NOT pg_is_in_recovery()" 2>/dev/null | grep -q t; then
    ready=1
    break
  fi
  sleep 2
done
[[ -n "$ready" ]] || { docker logs "$scratch" | tail -n 20 >&2; echo "The restored server never finished recovery." >&2; exit 1; }

found=$(docker exec "$scratch" psql -U tipme -d tipme -Atq -c "SELECT count(*) FROM recovery_markers WHERE id = '$marker'")
unbalanced=$(docker exec "$scratch" psql -U tipme -d tipme -Atq -c "SELECT count(*) FROM (
  SELECT 1 FROM ledger_entries GROUP BY transaction_id, currency
  HAVING sum(CASE side WHEN 'debit' THEN amount_minor ELSE -amount_minor END) <> 0) x")

# Recorded either way: the retention coordinator prunes only after a recent pass.
record() {
  sql "DO \$\$ BEGIN IF to_regclass('public.recovery_drills') IS NOT NULL THEN
         INSERT INTO recovery_drills (id, kind, base_file, passed, ran_at)
         VALUES (gen_random_uuid(), 'pitr', '$(basename "$base")', $1, now());
       END IF; END \$\$" >/dev/null
}

if [[ "$found" == "1" && "$unbalanced" == "0" ]]; then
  record true
  echo "PITR drill PASSED: the row written after $(basename "$base") was recovered from archived WAL; the books balance."
else
  record false
  echo "PITR drill FAILED: marker found=$found, unbalanced ledger transactions=$unbalanced." >&2
  exit 1
fi
