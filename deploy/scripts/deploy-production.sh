#!/usr/bin/env bash
# Deploys one version to production with no downtime (blue/green). GitHub Actions has already
# built, tested and shipped the image and this version's files (deploy-production workflow).
#   roles → migrate (as the migrator; Aiven backs up continuously) → roles → start the idle colour
#   on the new version → wait until the public API serves it → stop the old colour → replace the
#   workers one at a time → record.
# If the new colour is unhealthy it is stopped and the old colour keeps serving (nothing else
# changes). Migrations are forward-only and must stay compatible with the release still serving.
#
#   deploy/scripts/deploy-production.sh <version>     # version = git sha
set -euo pipefail
TIPME_STACK=production
source "$(dirname "$0")/lib.sh"

version=${1:?usage: deploy-production.sh <version>}
[[ "$version" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Not a version (git sha): $version" >&2; exit 2; }
take_lock
preflight
shipped "$version" || {
  echo "tipme-app:$version is not loaded, or its files are not in $RELEASES/$version: ship it with the deploy-production workflow first." >&2
  exit 2
}

echo "==> Queue"
# --no-recreate: started if absent, never restarted (a changed Compose file would recreate it).
compose_for "$version" up -d --wait --no-recreate redis

echo "==> Database roles"
compose_for "$version" run --rm db-roles

echo "==> Migrations"
MIGRATE_CONFIRM_DATABASE=$(setting MIGRATE_CONFIRM_DATABASE) MIGRATE_BACKUP_DONE=1 \
  compose_for "$version" run --rm migrate
compose_for "$version" run --rm db-roles

start_idle_colour "$version"
# The switch is the commit point: from here the new version serves.
[[ "$(tail -n 1 "$DEPLOYED")" == "$version" ]] || echo "$version" >>"$DEPLOYED"
set_current "$version"
switch_to_idle "$version"
prune_versions
echo "==> Deployed $version on api-$active_colour."
