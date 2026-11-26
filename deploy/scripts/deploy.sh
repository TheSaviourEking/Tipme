#!/usr/bin/env bash
# Deploys one version to staging (PR-010). GitHub Actions has already built and tested the images
# (API/worker and website) and shipped them here (deploy-staging workflow): this only runs them.
#   backup → pause the worker → migrate (guarded) → switch (API, worker, website) → health (the API's
#   version, and the website's at WEB_ORIGIN) → record → prune old versions.
# If the new version is unhealthy it puts the previous one back (no down-migrations: migrations
# are forward-only and must stay compatible with the previous release).
#
#   deploy/scripts/deploy.sh <version>     # version = 12-character git sha
set -euo pipefail
TIPME_STACK=staging # never production's files, whatever the environment says
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

# As production: the old worker is paused while the migrations run (lib.sh, "Workers paused for
# migrations"), and started again by the exit trap if the deploy stops before the switch.
trap resume_paused_workers EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
pause_workers "$version" worker

echo "==> Migrations"
MIGRATE_CONFIRM_DATABASE=tipme MIGRATE_BACKUP_DONE=1 compose_for "$version" run --rm migrate
resume_reason="the deploy stopped after migrating, before the switch"
compose_for "$version" exec -T postgres sh /opt/tipme/bootstrap-roles.sh

echo "==> Switching to $version"
compose_for "$version" up -d --remove-orphans $(app_services "$version")
# The switch started the new version's worker (and an unhealthy deploy puts the previous one back).
worker_replaced worker
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
