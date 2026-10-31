#!/usr/bin/env bash
# Shared by the deploy scripts (PR-010). Runs on the server as that stack's deploy user:
#   TIPME_STACK=staging (default): deploy.sh, rollback.sh; /srv/tipme, staging.env
#   TIPME_STACK=production: deploy-production.sh, rollback-production.sh; /srv/tipme-production
# GitHub Actions builds and ships each version: the image (docker load) and that version's deploy
# files in $TIPME_HOME/releases/<version>/. The server never builds or fetches code.
set -euo pipefail

TIPME_STACK=${TIPME_STACK:-staging}
case "$TIPME_STACK" in
  staging)
    TIPME_HOME=${TIPME_HOME:-/srv/tipme}
    ENV_FILE="$TIPME_HOME/staging.env"
    COMPOSE_FILE=compose.staging.yml
    ;;
  production)
    TIPME_HOME=${TIPME_HOME:-/srv/tipme-production}
    ENV_FILE="$TIPME_HOME/production.env"
    COMPOSE_FILE=compose.production.yml
    ;;
  *)
    echo "TIPME_STACK must be staging or production." >&2
    exit 2
    ;;
esac
RELEASES="$TIPME_HOME/releases"
DEPLOYED="$RELEASES/deployed" # every version deployed, oldest first
CURRENT="$RELEASES/current"   # the version running now
COLOURS="$RELEASES/colours"   # production: blue=<version>, green=<version>, active=blue|green
LOCK="$RELEASES/.deploy.lock" # production: held while a deploy or rollback runs
HEALTH_TRIES=${HEALTH_TRIES:-90}
KEEP_VERSIONS=${KEEP_VERSIONS:-5}
mkdir -p "$RELEASES"
[[ "$TIPME_STACK" == staging ]] && mkdir -p "$TIPME_HOME/backups"
touch "$DEPLOYED"

# Production's colour state, read once here; the scripts change these and then record them.
# A colour never deployed runs nothing, so Compose gets `none` for it (as its file defaults).
colour_setting() { awk -F= -v key="$1" '$1 == key { value = $2 } END { print value }' "$COLOURS" 2>/dev/null || true; }
blue_version=$(colour_setting blue)
green_version=$(colour_setting green)
active_colour=$(colour_setting active)

# docker compose for one version (image tag = git sha), with the server's settings. In production
# Compose reads both colours for any command, so every call gets both colours' versions: one left
# out would default to `none`, and a later `up` of that colour would recreate it on tipme-app:none.
compose_for() {
  local version=$1
  shift
  if [[ "$TIPME_STACK" == production ]]; then
    TIPME_HOME="$TIPME_HOME" TIPME_VERSION="$version" \
      TIPME_BLUE_VERSION="${blue_version:-none}" TIPME_GREEN_VERSION="${green_version:-none}" \
      docker compose -f "$RELEASES/$version/$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
    return
  fi
  TIPME_VERSION="$version" TIPME_ENV_FILE="$ENV_FILE" TIPME_BACKUP_DIR="$TIPME_HOME/backups" \
    docker compose -f "$RELEASES/$version/compose.staging.yml" --env-file "$ENV_FILE" "$@"
}

# A version can run only if Actions shipped both its image and its deploy files.
shipped() {
  local version=$1
  docker image inspect "tipme-app:$version" >/dev/null 2>&1 &&
    [[ -f "$RELEASES/$version/$COMPOSE_FILE" ]]
}

# Keeps the images and files of the newest KEEP_VERSIONS deployed versions (and the current one,
# and in production both colours' versions: the stopped colour is the instant rollback target).
# Versions shipped but not deployed yet are never touched.
prune_versions() {
  local current keep version
  current=$(current_version)
  keep=$(awk '!seen[$0]++' "$DEPLOYED" | tail -n "$KEEP_VERSIONS")
  while read -r version; do
    [[ -z "$version" || "$version" == "$current" ]] && continue
    [[ "$TIPME_STACK" == production && ("$version" == "$blue_version" || "$version" == "$green_version") ]] && continue
    grep -qx "$version" <<<"$keep" && continue
    docker image rm "tipme-app:$version" >/dev/null 2>&1 || true
    rm -rf "${RELEASES:?}/$version"
  done < <(awk '!seen[$0]++' "$DEPLOYED")
}

setting() { grep -E "^$1=" "$ENV_FILE" | head -n 1 | cut -d= -f2-; }
api_host() { setting API_HOST; }

# Settings that would break the first deploy, caught before anything runs.
preflight() {
  if [[ "$TIPME_STACK" == production ]]; then
    preflight_production
    return
  fi
  role_passwords POSTGRES_PASSWORD POSTGRES_RUNTIME_PASSWORD POSTGRES_MIGRATOR_PASSWORD POSTGRES_BACKUP_PASSWORD
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

# Production runs on Aiven: no local Postgres and no backup folder (Aiven keeps the backups).
# Messages name settings, never their values.
preflight_production() {
  local name
  if [[ ! -f "$TIPME_HOME/db-ca.pem" ]]; then
    echo "$TIPME_HOME/db-ca.pem (Aiven's CA certificate) is missing: see docs/runbooks/remote-database.md." >&2
    exit 2
  fi
  for name in DATABASE_URL MIGRATION_DATABASE_URL DATABASE_ADMIN_URL MIGRATE_CONFIRM_DATABASE; do
    if [[ -z "$(setting "$name" || true)" ]]; then
      echo "$name is required in $ENV_FILE." >&2
      exit 2
    fi
  done
  role_passwords POSTGRES_RUNTIME_PASSWORD POSTGRES_MIGRATOR_PASSWORD POSTGRES_BACKUP_PASSWORD
  if ! docker network inspect edge-production >/dev/null 2>&1; then
    echo "The edge-production network does not exist: create it with deploy/edge/setup-networks.sh first." >&2
    exit 2
  fi
}

# Each role password present, safe inside a URL, and different from the others (one shared
# password would collapse the roles' separation).
role_passwords() {
  local name password i j
  local -a passwords=()
  for name in "$@"; do
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
}

# Waits until the public API answers ready and reports the expected version. In production the
# edge round-robins over both colours while they overlap, so some polls still reach the old one:
# it is enough that the new version answers once (only ready copies get traffic).
# HEALTH_BASE_URL (a setting) replaces https://<API_HOST>, e.g. plain http for a local rehearsal.
wait_healthy() {
  local version=$1 base
  base=$(setting HEALTH_BASE_URL || true)
  [[ -n "$base" ]] || base="https://$(api_host)"
  for _ in $(seq 1 "$HEALTH_TRIES"); do
    # --max-time: a hung edge must count as a failed poll, not stall the deploy.
    if curl -sf --max-time 10 "$base/health/ready" >/dev/null &&
      curl -sf --max-time 10 "$base/health/release" | grep -q "\"version\":\"$version\""; then
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

# The edge Caddy reaches staging's API as staging-api on edge-staging. A version from before the
# edge move does not join that network itself, so after bringing any version up, attach its API
# there when it is not already (rollbacks and the automatic restore go through this). Staging
# problems are fixed here, never by stopping the edge, which production shares.
attach_edge() {
  local id
  id=$(compose_for "$1" ps -q api | head -n 1)
  [[ -n "$id" ]] || return 0
  if docker inspect -f '{{range $name, $net := .NetworkSettings.Networks}}{{$name}} {{end}}' "$id" | grep -qw edge-staging; then
    return 0
  fi
  docker network connect --alias staging-api edge-staging "$id" ||
    echo "!! Could not attach the API to edge-staging: staging is unreachable through the edge." >&2
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

# --- Production only (blue/green) ---

# One deploy or rollback at a time: a second would pick the same idle colour and could stop the
# one serving. mkdir is atomic (flock is not on every host the tests run on). Released on exit.
take_lock() {
  if ! mkdir "$LOCK" 2>/dev/null; then
    echo "Another deploy or rollback is running (lock: $LOCK)." >&2
    echo "If none is (no deploy-production workflow or script running), clear it: rm -rf $LOCK" >&2
    exit 2
  fi
  echo "pid $$ since $(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$LOCK/owner"
  trap 'rm -rf "$LOCK"' EXIT
  # Bash skips the EXIT trap when a signal kills it (a dropped SSH session sends HUP).
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
}

# The colour not serving now (blue before the first deploy).
idle_colour() { [[ "$active_colour" == blue ]] && echo green || echo blue; }

# Sets the version a colour runs (in the variables compose_for passes, not yet recorded).
set_colour_version() {
  if [[ "$1" == blue ]]; then blue_version=$2; else green_version=$2; fi
}

# Records which version each colour runs and which one serves, in one rename.
record_colours() {
  {
    [[ -n "$blue_version" ]] && echo "blue=$blue_version"
    [[ -n "$green_version" ]] && echo "green=$green_version"
    echo "active=$active_colour"
  } >"$COLOURS.tmp"
  mv "$COLOURS.tmp" "$COLOURS"
}

# Brings <version> up on the idle colour and waits until the public API serves it. On failure
# the new colour is stopped and nothing is recorded: the active colour never stopped.
start_idle_colour() {
  local version=$1 idle
  idle=$(idle_colour)
  set_colour_version "$idle" "$version"
  echo "==> Starting $version on api-$idle"
  if compose_for "$version" up -d --wait --no-deps "api-$idle" && wait_healthy "$version"; then
    return 0
  fi
  echo "!! $version did not become healthy on api-$idle: stopping it; api-${active_colour:-none} keeps serving." >&2
  compose_for "$version" stop -t 20 "api-$idle" || echo "!! Could not stop api-$idle: stop it by hand." >&2
  exit 1
}

# The new colour serves: record it first (if anything later fails, the state names the colour that
# is serving), then stop the old colour (the edge stops sending it traffic as it fails readiness;
# 20 s covers its drain) and replace the workers one at a time onto the same version.
switch_to_idle() {
  local version=$1 old=$active_colour
  active_colour=$(idle_colour)
  record_colours
  if [[ -n "$old" ]]; then
    echo "==> Stopping api-$old"
    compose_for "$version" stop -t 20 "api-$old"
  fi
  for worker in worker-a worker-b; do
    echo "==> Replacing $worker"
    compose_for "$version" up -d --wait --no-deps "$worker"
  done
}
