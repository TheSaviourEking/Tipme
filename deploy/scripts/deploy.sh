#!/usr/bin/env bash
# Deploys one version to staging (PR-010). GitHub Actions has already built and tested the image
# and shipped it here (deploy-staging workflow): this only runs it.
#   backup → migrate (guarded) → switch → health → record → prune old versions.
# If the new version is unhealthy it puts the previous one back (no down-migrations: migrations
# are forward-only and must stay compatible with the previous release).
#
#   deploy/scripts/deploy.sh <version>     # version = 12-character git sha
set -euo pipefail
source "$(dirname "$0")/lib.sh"

version=${1:?usage: deploy.sh <version>}
[[ "$version" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Not a version (git sha): $version" >&2; exit 2; }
preflight
shipped "$version" || {
  echo "tipme-app:$version is not loaded, or its files are not in $RELEASES/$version: ship it with the deploy-staging workflow first." >&2
  exit 2
}
previous=$(current_version)

echo "==> Database and queue"
compose_for "$version" up -d --wait postgres redis

echo "==> Database roles"
compose_for "$version" exec -T postgres sh /opt/tipme/bootstrap-roles.sh

echo "==> Backup before migrating"
compose_for "$version" run --rm backup sh deploy/backup-loop.sh once

echo "==> Migrations"
MIGRATE_CONFIRM_DATABASE=tipme MIGRATE_BACKUP_DONE=1 compose_for "$version" run --rm migrate
compose_for "$version" exec -T postgres sh /opt/tipme/bootstrap-roles.sh

echo "==> Switching to $version"
compose_for "$version" up -d --remove-orphans $(app_services "$version")
attach_edge "$version"

if wait_healthy "$version"; then
  echo "$version" >>"$DEPLOYED"
  set_current "$version"
  prune_versions
  echo "==> Deployed $version."
else
  echo "!! $version did not become healthy." >&2
  if [[ -n "$previous" ]]; then
    echo "!! Putting $previous back." >&2
    compose_for "$previous" up -d --remove-orphans $(app_services "$previous")
    attach_edge "$previous"
    wait_healthy "$previous" && echo "!! Back on $previous." >&2
  fi
  exit 1
fi
