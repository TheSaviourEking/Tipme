#!/usr/bin/env bash
# Shared by deploy.sh and rollback.sh (PR-010). Runs on the staging server as the deploy user.
set -euo pipefail

TIPME_HOME=${TIPME_HOME:-/srv/tipme}
APP_DIR="$TIPME_HOME/app"
ENV_FILE="$TIPME_HOME/staging.env"
RELEASES="$TIPME_HOME/releases"
DEPLOYED="$RELEASES/deployed" # every version deployed, oldest first
CURRENT="$RELEASES/current"   # the version running now
HEALTH_TRIES=${HEALTH_TRIES:-90}
mkdir -p "$RELEASES" "$TIPME_HOME/backups"
touch "$DEPLOYED"

# docker compose for one version (image tag = git sha), with the server's settings.
compose_for() {
  local version=$1
  shift
  TIPME_VERSION="$version" TIPME_ENV_FILE="$ENV_FILE" TIPME_BACKUP_DIR="$TIPME_HOME/backups" \
    docker compose -f "$APP_DIR/deploy/compose.staging.yml" --env-file "$ENV_FILE" "$@"
}

setting() { grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2-; }
api_host() { setting API_HOST; }

# Settings that would break the first deploy, caught before anything runs.
preflight() {
  local password
  password=$(setting POSTGRES_PASSWORD)
  if [[ ! "$password" =~ ^[A-Za-z0-9_-]{16,}$ ]]; then
    echo "POSTGRES_PASSWORD must be 16+ letters, digits, '-' or '_' (it goes inside a URL): use 'openssl rand -hex 32'." >&2
    exit 2
  fi
  # The image runs as uid 1000 and writes backups into this folder (Linux hosts).
  local owner
  if owner=$(stat -c %u "$TIPME_HOME/backups" 2>/dev/null) && [[ "$owner" != "1000" ]]; then
    echo "$TIPME_HOME/backups must belong to uid 1000 (the image's user): sudo chown 1000:1000 $TIPME_HOME/backups" >&2
    exit 2
  fi
}

# Waits until the public API answers ready and reports the expected version.
wait_healthy() {
  local version=$1 host
  host=$(api_host)
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    if curl -sf "https://$host/health/ready" >/dev/null &&
      curl -sf "https://$host/health/release" | grep -q "\"version\":\"$version\""; then
      return 0
    fi
    sleep 2
  done
  return 1
}

current_version() { cat "$CURRENT" 2>/dev/null || true; }
# The version deployed just before the current one's most recent deploy (never a later one),
# so rolling back twice walks further back instead of returning to the version backed out.
version_before() {
  local current=$1
  awk -v cur="$current" '{ v[NR] = $0; if ($0 == cur) last = NR } END { if (last > 1) print v[last - 1] }' "$DEPLOYED"
}
