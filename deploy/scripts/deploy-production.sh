#!/usr/bin/env bash
# Deploys one version to production with no downtime (blue/green). GitHub Actions has already
# built, tested and shipped the image and this version's files (deploy-production workflow).
#   roles → pause the old workers → migrate (as the migrator; Aiven backs up continuously) → roles
#   → start the idle colour on the new version → wait until the public API serves it → stop the old
#   colour → replace the workers one at a time → record. Old workers paused and not yet replaced
#   are started again whenever the deploy stops early.
# If the new colour is unhealthy it is stopped and the old colour keeps serving (nothing else
# changes). Migrations are forward-only and must stay compatible with the release still serving.
#
#   deploy/scripts/deploy-production.sh <version> [live]
#     version = git sha. live = true|false, what the env file must say about live payments (default
#     false). Deploying the version already running applies a changed env file, with no new build.
set -euo pipefail
TIPME_STACK=production
source "$(dirname "$0")/lib.sh"

version=${1:?usage: deploy-production.sh <version> [true|false]}
expected_live=${2:-false}
[[ "$version" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Not a version (git sha): $version" >&2; exit 2; }
take_lock
preflight
preflight_live_payments "$expected_live"
shipped "$version" || {
  echo "tipme-app:$version is not loaded, or its files are not in $RELEASES/$version: ship it with the deploy-production workflow first." >&2
  exit 2
}
compose_agrees_on_live "$version" "$expected_live"

echo "==> Queue"
# --no-recreate: started if absent, never restarted (a changed Compose file would recreate it).
compose_for "$version" up -d --wait --no-recreate redis

echo "==> Database roles"
compose_for "$version" run --rm db-roles

# The old workers' jobs deadlocked with the migration transaction (lib.sh, "Workers paused for
# migrations"). The API colours keep serving. If anything stops this deploy before the new workers
# replace them, the exit trap (take_lock) starts the same worker containers again.
pause_workers "$version" worker-a worker-b

echo "==> Migrations"
MIGRATE_CONFIRM_DATABASE=$(setting MIGRATE_CONFIRM_DATABASE) MIGRATE_BACKUP_DONE=1 \
  compose_for "$version" run --rm migrate
# Migrated: the old workers still run on the new schema (migrations stay compatible with the
# release serving), so a deploy stopped from here on resumes them too.
resume_reason="the deploy stopped after migrating, before the new workers started"
compose_for "$version" run --rm db-roles

start_idle_colour "$version"
# The switch is the commit point: from here the new version serves.
[[ "$(tail -n 1 "$DEPLOYED")" == "$version" ]] || echo "$version" >>"$DEPLOYED"
set_current "$version"
switch_to_idle "$version"
prune_versions
echo "==> Deployed $version on api-$active_colour."
