#!/usr/bin/env bash
# Rolls staging back to the version deployed before the current one (PR-010). No migration runs:
# the database stays on the newer schema, which the previous release must accept (expand/contract).
# Rolling back again goes further back, never forward. The web app rolls back in Vercel.
#
#   deploy/scripts/rollback.sh            # to the version deployed before the current one
#   deploy/scripts/rollback.sh <version>  # to a specific earlier version (its image must exist)
set -euo pipefail
source "$(dirname "$0")/lib.sh"

current=$(current_version)
target=${1:-$(version_before "$current")}
[[ -n "$target" && "$target" != "$current" ]] || { echo "No earlier version to roll back to." >&2; exit 2; }
shipped "$target" || { echo "tipme-app:$target is no longer on this server; ship and deploy it instead." >&2; exit 2; }

echo "==> Rolling back $current → $target"
compose_for "$target" up -d --remove-orphans $(app_services "$target")
wait_healthy "$target" || { echo "!! $target did not become healthy." >&2; exit 1; }
set_current "$target"
# A version from before PR-011 runs Postgres without WAL archiving (its Compose file restarts it).
if grep -q 'archive_mode=on' "$RELEASES/$current/compose.staging.yml" 2>/dev/null &&
  ! grep -q 'archive_mode=on' "$RELEASES/$target/compose.staging.yml"; then
  echo "!! WAL archiving is OFF in $target: point-in-time recovery stops until you deploy a newer version again." >&2
  echo "!! Daily logical backups still run. The staging watcher will also report this." >&2
fi
echo "==> Rolled back to $target. Run the release check (read-only, then --full)."
