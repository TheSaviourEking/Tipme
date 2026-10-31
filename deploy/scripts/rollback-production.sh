#!/usr/bin/env bash
# Rolls production back to the version deployed before the current one, with no downtime: the
# target starts on the idle colour (usually it is still there, stopped), the current colour stops
# once the target serves, then the workers move one at a time. No migration and no role setup run:
# the database stays on the newer schema, which the earlier release must accept (expand/contract).
# Rolling back again goes further back, never forward. The web app rolls back in Vercel.
#
#   deploy/scripts/rollback-production.sh            # to the version deployed before the current one
#   deploy/scripts/rollback-production.sh <version>  # to a specific earlier version (still shipped)
set -euo pipefail
TIPME_STACK=production
source "$(dirname "$0")/lib.sh"

take_lock
current=$(current_version)
target=${1:-$(version_before "$current")}
[[ -n "$target" && "$target" != "$current" ]] || { echo "No earlier version to roll back to." >&2; exit 2; }
shipped "$target" || { echo "tipme-app:$target is no longer on this server; ship and deploy it instead." >&2; exit 2; }
# Only a version deployed before the current one: its code already ran against this schema's
# predecessors and the expand/contract rule covers it. A newer one should be deployed instead.
awk -v cur="$current" -v want="$target" '$0 == want { seen = 1 } $0 == cur { if (seen) found = 1 } END { exit !found }' "$DEPLOYED" || {
  echo "$target was not deployed before $current; deploy it with deploy-production.sh instead." >&2
  exit 2
}

echo "==> Rolling back $current → $target"
start_idle_colour "$target"
set_current "$target"
switch_to_idle "$target"
echo "==> Rolled back to $target on api-$active_colour. Run the release check (read-only)."
