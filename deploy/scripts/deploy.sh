#!/usr/bin/env bash
# Deploys one git commit to staging (PR-010):
#   build → backup → migrate (guarded) → switch → health → record.
# On failure after the switch it puts the previous version back (no down-migrations: migrations
# are forward-only and must stay compatible with the previous release).
#
#   deploy/scripts/deploy.sh <git sha>
set -euo pipefail
source "$(dirname "$0")/lib.sh"

sha=${1:?usage: deploy.sh <git sha>}
[[ "$sha" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Not a git sha: $sha" >&2; exit 2; }
preflight
previous=$(current_version)

echo "==> Fetching $sha"
git -C "$APP_DIR" fetch --quiet origin
git -C "$APP_DIR" checkout --quiet --detach "$sha"
version=$(git -C "$APP_DIR" rev-parse --short=12 HEAD)

echo "==> Building tipme-app:$version"
docker build -f "$APP_DIR/deploy/Dockerfile" -t "tipme-app:$version" "$APP_DIR"

echo "==> Database and queue"
compose_for "$version" up -d --wait postgres redis

echo "==> Backup before migrating"
compose_for "$version" run --rm backup sh deploy/backup-loop.sh once

echo "==> Migrations"
MIGRATE_CONFIRM_DATABASE=tipme MIGRATE_BACKUP_DONE=1 compose_for "$version" run --rm migrate

echo "==> Switching to $version"
compose_for "$version" up -d --remove-orphans api worker caddy backup

if wait_healthy "$version"; then
  echo "$version" >>"$DEPLOYED"
  echo "$version" >"$CURRENT"
  echo "==> Deployed $version. Now run the release check from your machine:"
  echo "    pnpm release:check --web https://<staging host> --api https://$(api_host) --expect-version $version --full"
else
  echo "!! $version did not become healthy." >&2
  if [[ -n "$previous" ]]; then
    echo "!! Putting $previous back." >&2
    git -C "$APP_DIR" checkout --quiet --detach "$previous"
    compose_for "$previous" up -d --remove-orphans api worker caddy backup
    wait_healthy "$previous" && echo "!! Back on $previous." >&2
  fi
  exit 1
fi
