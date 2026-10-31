#!/usr/bin/env bash
# Shared by deploy.sh and rollback.sh (PR-010). Runs on the staging server as the deploy user.
# GitHub Actions builds and ships each version: the image (docker load) and that version's deploy
# files in $TIPME_HOME/releases/<version>/. The server never builds or fetches code.
set -euo pipefail

TIPME_HOME=${TIPME_HOME:-/srv/tipme}
ENV_FILE="$TIPME_HOME/staging.env"
RELEASES="$TIPME_HOME/releases"
DEPLOYED="$RELEASES/deployed" # every version deployed, oldest first
CURRENT="$RELEASES/current"   # the version running now
HEALTH_TRIES=${HEALTH_TRIES:-90}
KEEP_VERSIONS=${KEEP_VERSIONS:-5}
mkdir -p "$RELEASES" "$TIPME_HOME/backups"
touch "$DEPLOYED"

# docker compose for one version (image tag = git sha), with the server's settings.
compose_for() {
  local version=$1
  shift
  TIPME_VERSION="$version" TIPME_ENV_FILE="$ENV_FILE" TIPME_BACKUP_DIR="$TIPME_HOME/backups" \
    docker compose -f "$RELEASES/$version/compose.staging.yml" --env-file "$ENV_FILE" "$@"
}

# A version can run only if Actions shipped both its image and its deploy files.
shipped() {
  local version=$1
  docker image inspect "tipme-app:$version" >/dev/null 2>&1 &&
    [[ -f "$RELEASES/$version/compose.staging.yml" ]]
}

# Keeps the images and files of the newest KEEP_VERSIONS deployed versions (and the current one).
# Versions shipped but not deployed yet are never touched.
prune_versions() {
  local current keep version
  current=$(current_version)
  keep=$(awk '!seen[$0]++' "$DEPLOYED" | tail -n "$KEEP_VERSIONS")
  while read -r version; do
    [[ -z "$version" || "$version" == "$current" ]] && continue
    grep -qx "$version" <<<"$keep" && continue
    docker image rm "tipme-app:$version" >/dev/null 2>&1 || true
    rm -rf "${RELEASES:?}/$version"
  done < <(awk '!seen[$0]++' "$DEPLOYED")
}

setting() { grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2-; }
api_host() { setting API_HOST; }

# Settings that would break the first deploy, caught before anything runs.
preflight() {
  local name password i j
  local -a passwords=()
  for name in POSTGRES_PASSWORD POSTGRES_RUNTIME_PASSWORD POSTGRES_MIGRATOR_PASSWORD POSTGRES_BACKUP_PASSWORD; do
    if ! password=$(setting "$name"); then
      echo "$name is required in $ENV_FILE." >&2
      exit 2
    fi
    if [[ ! "$password" =~ ^[A-Za-z0-9_-]{16,}$ ]]; then
      echo "$name must be 16+ letters, digits, '-' or '_' (it goes inside a URL): use 'openssl rand -hex 32'." >&2
      exit 2
    fi
    passwords+=("$password")
  done
  for ((i = 0; i < ${#passwords[@]}; i++)); do
    for ((j = 0; j < i; j++)); do
      if [[ "${passwords[$i]}" == "${passwords[$j]}" ]]; then
        echo "Postgres role passwords must be unique." >&2
        exit 2
      fi
    done
  done
  # The image runs as uid 1000 and writes backups into this folder (Linux hosts).
  local owner
  if owner=$(stat -c %u "$TIPME_HOME/backups" 2>/dev/null) && [[ "$owner" != "1000" ]]; then
    echo "$TIPME_HOME/backups must belong to uid 1000 (the image's user): sudo chown 1000:1000 $TIPME_HOME/backups" >&2
    exit 2
  fi
  # The edge Caddy reaches the API over this network; without it `up` would fail halfway through.
  if ! docker network inspect edge-staging >/dev/null 2>&1; then
    echo "The edge-staging network does not exist: do the one-off edge move first (docs/runbooks/staging-setup.md, 'Move Caddy to the edge')." >&2
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
# Records the running version and points $TIPME_HOME/live at its files (runbook commands use it).
set_current() {
  echo "$1" >"$CURRENT"
  ln -sfn "$RELEASES/$1" "$TIPME_HOME/live"
}
# The version deployed just before the current one's most recent deploy (never a later one),
# so rolling back twice walks further back instead of returning to the version backed out.
version_before() {
  local current=$1
  awk -v cur="$current" '{ v[NR] = $0; if ($0 == cur) last = NR } END { if (last > 1) print v[last - 1] }' "$DEPLOYED"
}

# The long-running services a version defines (newer versions add some, e.g. retention), so a
# rollback to an older version never asks Compose for a service its file doesn't have.
# Never caddy: older versions' files still define it, but the edge (deploy/edge) owns 80/443 now.
app_services() {
  local defined
  defined=$(compose_for "$1" config --services)
  for service in api worker backup retention; do
    grep -qx "$service" <<<"$defined" && printf '%s ' "$service"
  done
}
