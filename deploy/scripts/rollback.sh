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
docker image inspect "tipme-app:$target" >/dev/null || { echo "Image tipme-app:$target is gone; deploy it instead." >&2; exit 2; }

echo "==> Rolling back $current → $target"
git -C "$APP_DIR" checkout --quiet --detach "$target"
compose_for "$target" up -d --remove-orphans api worker caddy backup
wait_healthy "$target" || { echo "!! $target did not become healthy." >&2; exit 1; }
echo "$target" >"$CURRENT"
echo "==> Rolled back to $target. Run the release check (read-only, then --full)."
