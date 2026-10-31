#!/usr/bin/env bash
# Local no-downtime rehearsal of a production deploy and rollback, on real Docker, under load.
# It is the evidence for "no request fails during a deploy" (production plan, Task 9).
#
#   scripts/rehearse-production.sh                       # images from HEAD
#   REHEARSAL_REV=8b2db32 scripts/rehearse-production.sh # images from another commit
#   REHEARSAL_RATE=60 scripts/rehearse-production.sh     # requests per second (default 30)
#   REHEARSAL_PREBUILT=1 scripts/rehearse-production.sh  # use existing tipme-app:<A>/<B>, keep them
#
# What it does, all under a temporary TIPME_HOME:
#   1. Builds tipme-app:<A> from REHEARSAL_REV (git archive, so only committed code) and
#      tipme-app:<B> = A plus one label, so the two versions differ.
#   2. Generates a throwaway CA and a server certificate for rehearsal-db, the Postgres 16
#      stand-in for Aiven (TLS only), so sslmode=verify-full is really checked.
#   3. Creates edge-production and runs the real edge Caddyfile on it (plain http for
#      localhost, on a random loopback port).
#   4. Writes the release folders the way ship-production.sh does (compose file + deploy
#      scripts), with deploy/local/compose.production-rehearsal.yml merged into the compose file,
#      and deploys A with the real deploy-production.sh (db-roles, migrate, blue/green).
#   5. Starts k6 (REHEARSAL_RATE requests/s for REHEARSAL_DURATION) through the edge, deploys B
#      during the run, then rolls back to A during the run.
# Passes only if k6 reports no failed request and /health/release shows B after the deploy and
# A after the rollback (every answer, not just one).
#
# NOT proven here: production-mode boot. Production's config refuses every payment provider
# until the payments plan adds bachs-live, so the API and workers run in password-protected
# preview with the mock provider and mock mail (everything else is production's). Production
# mode is proven on launch day, step 2 (docs/runbooks/production.md).
#
# Touches nothing it did not create: it refuses to start if any name it would use exists
# (tipme-production-* containers and volumes, edge-production, tipme-rehearsal-*, the two image
# tags), and on exit, pass or fail, removes every container, network, volume and image it made.
# Logs (deploys, k6 summary, API logs on failure) stay in the folder it prints at the end.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
REV=${REHEARSAL_REV:-HEAD}
A=${REHEARSAL_VERSION_A:-aaaaaaa0001}
B=${REHEARSAL_VERSION_B:-bbbbbbb0002}
RATE=${REHEARSAL_RATE:-30}
DURATION=${REHEARSAL_DURATION:-90s}
# Pinned like scripts/load-test.mjs.
K6_IMAGE=grafana/k6:1.0.0@sha256:f21270290d702cbf0a7d6ba5d7ed100b63bcb233b558b885ed787547b3488279
CADDY_IMAGE=caddy:2.10.2-alpine
EDGE=tipme-rehearsal-edge
K6=tipme-rehearsal-k6
PROJECT=tipme-production

for version in "$A" "$B"; do
  [[ "$version" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Not a version (7-40 hex): $version" >&2; exit 2; }
done
[[ "$A" != "$B" ]] || { echo "The two versions must differ." >&2; exit 2; }
commit=$(git -C "$here" rev-parse --verify "$REV^{commit}")

# --- Nothing of ours may exist yet: we remove only what we create ---
clash=()
[[ -n "$(docker ps -aq --filter "name=^$PROJECT-")" ]] && clash+=("containers $PROJECT-*")
[[ -n "$(docker ps -aq --filter "name=^tipme-rehearsal-")" ]] && clash+=("containers tipme-rehearsal-*")
[[ -n "$(docker volume ls -q --filter "name=^${PROJECT}_")" ]] && clash+=("volumes ${PROJECT}_*")
[[ -n "$(docker network ls -q --filter "name=^${PROJECT}_")" ]] && clash+=("networks ${PROJECT}_*")
docker network inspect edge-production >/dev/null 2>&1 && clash+=("network edge-production")
PREBUILT=${REHEARSAL_PREBUILT:-0}
for version in "$A" "$B"; do
  if [[ "$PREBUILT" == 1 ]]; then
    docker image inspect "tipme-app:$version" >/dev/null 2>&1 ||
      { echo "REHEARSAL_PREBUILT=1 needs tipme-app:$version to exist." >&2; exit 2; }
  else
    docker image inspect "tipme-app:$version" >/dev/null 2>&1 && clash+=("image tipme-app:$version")
  fi
done
if ((${#clash[@]})); then
  echo "Refusing to rehearse: these already exist and are not ours to touch: ${clash[*]}" >&2
  exit 2
fi

TIPME_HOME=$(cd "$(mktemp -d "${TMPDIR:-/tmp}/tipme-rehearsal.XXXXXX")" && pwd -P)
LOGS=${REHEARSAL_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/tipme-rehearsal-logs.XXXXXX")}
mkdir -p "$LOGS"
RELEASES="$TIPME_HOME/releases"
ENV_FILE="$TIPME_HOME/production.env"
export TIPME_HOME
built=()
made_edge_network=0

compose() {
  TIPME_VERSION="$A" TIPME_BLUE_VERSION=none TIPME_GREEN_VERSION=none \
    docker compose -p "$PROJECT" -f "$RELEASES/$A/compose.production.yml" --env-file "$ENV_FILE" "$@"
}

cleanup() {
  local status=$?
  trap - EXIT
  echo "==> Cleaning up"
  if ((status != 0)) && [[ -f "$RELEASES/$A/compose.production.yml" ]]; then
    compose logs --no-color --timestamps >"$LOGS/stack.log" 2>&1 || true
    docker logs "$EDGE" >"$LOGS/edge.log" 2>&1 || true
  fi
  docker rm -f "$K6" "$EDGE" >/dev/null 2>&1 || true
  if [[ -f "$RELEASES/$A/compose.production.yml" ]]; then
    compose --profile tools down -v --remove-orphans -t 20 >/dev/null 2>&1 || true
  fi
  # Whatever the file did not cover (e.g. a failure before it was written).
  local label="label=com.docker.compose.project=$PROJECT" id
  for id in $(docker ps -aq --filter "$label"); do docker rm -f "$id" >/dev/null 2>&1 || true; done
  for id in $(docker volume ls -q --filter "$label"); do docker volume rm "$id" >/dev/null 2>&1 || true; done
  for id in $(docker network ls -q --filter "$label"); do docker network rm "$id" >/dev/null 2>&1 || true; done
  ((made_edge_network)) && { docker network rm edge-production >/dev/null 2>&1 || true; }
  # ${built[@]+…}: an empty array is "unbound" under set -u in bash 3 (macOS).
  for image in ${built[@]+"${built[@]}"}; do docker image rm "$image" >/dev/null 2>&1 || true; done
  rm -rf "$TIPME_HOME"
  echo "Logs: $LOGS"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ "$PREBUILT" == 1 ]]; then
  echo "==> Using the existing tipme-app:$A and tipme-app:$B (kept afterwards)"
else
  echo "==> Building tipme-app:$A from $REV ($commit)"
  git -C "$here" archive --format=tar "$commit" |
    docker build -f deploy/Dockerfile -t "tipme-app:$A" - >"$LOGS/build-a.log" 2>&1 ||
    { tail -n 40 "$LOGS/build-a.log" >&2; exit 1; }
  built+=("tipme-app:$A")
  echo "==> Building tipme-app:$B (A plus a label)"
  printf 'FROM tipme-app:%s\nLABEL xyz.usetipme.rehearsal.version=%s\n' "$A" "$B" |
    docker build -t "tipme-app:$B" - >"$LOGS/build-b.log" 2>&1 ||
    { tail -n 40 "$LOGS/build-b.log" >&2; exit 1; }
  built+=("tipme-app:$B")
fi

echo "==> Throwaway CA and certificate for rehearsal-db"
tls="$TIPME_HOME/rehearsal-db-tls"
mkdir -p "$tls"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=TipMe rehearsal CA" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout "$tls/ca.key" -out "$TIPME_HOME/db-ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=rehearsal-db" \
  -keyout "$tls/server.key" -out "$tls/server.csr" 2>/dev/null
printf 'subjectAltName=DNS:rehearsal-db\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n' >"$tls/ext.cnf"
openssl x509 -req -in "$tls/server.csr" -CA "$TIPME_HOME/db-ca.pem" -CAkey "$tls/ca.key" \
  -CAcreateserial -days 2 -extfile "$tls/ext.cnf" -out "$tls/server.crt" 2>/dev/null
rm -f "$tls/ca.key" "$tls/server.csr" "$tls/ext.cnf" "$TIPME_HOME"/*.srl "$tls"/*.srl
chmod 644 "$TIPME_HOME/db-ca.pem" "$tls/server.crt"
# Read by root in the stand-in, which copies it to the postgres user with mode 600.
chmod 644 "$tls/server.key"

echo "==> Edge"
docker network create edge-production >/dev/null
made_edge_network=1
docker run -d --name "$EDGE" --network edge-production -p 127.0.0.1::80 \
  -e ACME_EMAIL=ops@rehearsal.invalid \
  -e STAGING_API_HOST=http://staging.rehearsal.invalid \
  -e PRODUCTION_API_HOST=http://localhost \
  -v "$here/deploy/edge/Caddyfile:/etc/caddy/Caddyfile:ro" \
  "$CADDY_IMAGE" >/dev/null
port=$(docker port "$EDGE" 80/tcp | head -n 1 | awk -F: '{ print $NF }')
# Caddy's host matcher ignores the port, so this reaches the production site block.
base="http://localhost:$port"

echo "==> Settings ($ENV_FILE, generated; never printed)"
hex() { openssl rand -hex 32; }
b64() { openssl rand -base64 "$1"; }
{
  echo "TIPME_HOME=$TIPME_HOME"
  echo "API_HOST=localhost"
  echo "HEALTH_BASE_URL=$base"
  # Preview requires https; it is never fetched here.
  echo "WEB_ORIGIN=https://web.rehearsal.invalid"
  runtime=$(hex) migrator=$(hex) backup=$(hex) admin=$(hex)
  echo "POSTGRES_RUNTIME_PASSWORD=$runtime"
  echo "POSTGRES_MIGRATOR_PASSWORD=$migrator"
  echo "POSTGRES_BACKUP_PASSWORD=$backup"
  echo "REHEARSAL_DB_ADMIN_PASSWORD=$admin"
  # The same URLs the rehearsal compose file sets (the deploy's preflight reads them here).
  ca='sslmode=verify-full&sslrootcert=/run/secrets/db-ca.pem'
  echo "DATABASE_URL=postgres://tipme_runtime:$runtime@rehearsal-db:5432/tipme?$ca"
  echo "MIGRATION_DATABASE_URL=postgres://tipme_migrator:$migrator@rehearsal-db:5432/tipme?$ca"
  echo "DATABASE_ADMIN_URL=postgres://rehearsal_admin:$admin@rehearsal-db:5432/tipme?$ca"
  echo "MIGRATE_CONFIRM_DATABASE=tipme"
  echo "PAYMENT_PROVIDER=mock"
  echo "PAYMENTS_LIVE_ENABLED=false"
  echo "PREVIEW_PASSWORD=$(hex)"
  echo "MOCK_PROVIDER_WEBHOOK_SECRET=$(hex)"
  echo "MAIL_DEFAULT_PROVIDER=mock"
  echo "MAIL_FROM_DOMAIN=rehearsal.invalid"
  echo "STATUS_TOKEN_SECRET=$(b64 48)"
  echo "AUTH_CODE_SECRET=$(b64 48)"
  echo "WEB_REVALIDATE_SECRET=$(b64 48)"
  echo "OPS_TOTP_KEY=$(b64 32)"
  echo "MAIL_SEAL_KEY=$(b64 32)"
  echo "LOG_LEVEL=warn"
} >"$ENV_FILE"
chmod 600 "$ENV_FILE"

echo "==> Release folders (as ship-production.sh lays them out)"
# Production's file with the rehearsal overrides merged in. Compose would read a bind mount whose
# source is still a variable as a named volume, so TIPME_HOME is written in first; every other
# setting stays a variable for the deploy scripts to fill, as on the server.
home_in() { sed "s|\${TIPME_HOME:?set TIPME_HOME}|$TIPME_HOME|g" "$1"; }
home_in "$here/deploy/compose.production.yml" >"$TIPME_HOME/compose.base.yml"
home_in "$here/deploy/local/compose.production-rehearsal.yml" >"$TIPME_HOME/compose.rehearsal.yml"
for version in "$A" "$B"; do
  mkdir -p "$RELEASES/$version"
  docker compose --profile '*' -f "$TIPME_HOME/compose.base.yml" -f "$TIPME_HOME/compose.rehearsal.yml" \
    config --no-interpolate >"$RELEASES/$version/compose.production.yml"
  cp -R "$here/deploy/scripts" "$RELEASES/$version/scripts"
done

echo "==> Postgres stand-in (TLS only)"
compose up -d --wait rehearsal-db >"$LOGS/db.log" 2>&1 || { cat "$LOGS/db.log" >&2; exit 1; }

deploy() { bash "$RELEASES/$1/scripts/deploy-production.sh" "$1"; }
rollback() { bash "$RELEASES/$A/scripts/rollback-production.sh"; }

# Every one of n answers from /health/release must name the version (both colours overlap
# during a switch, so only after the script returns may nothing but the new one answer).
all_answer() {
  local version=$1 seen
  for _ in $(seq 1 12); do
    seen=$(curl -sf --max-time 5 "$base/health/release" | grep -o '"version":"[^"]*"' || echo none)
    [[ "$seen" == "\"version\":\"$version\"" ]] || { echo "!! /health/release answered $seen, expected $version" >&2; return 1; }
  done
  echo "    /health/release: 12 of 12 answers are $version"
}

echo "==> Deploying $A (first deploy: roles, migrations, api-blue)"
deploy "$A" >"$LOGS/deploy-a.log" 2>&1 || { tail -n 40 "$LOGS/deploy-a.log" >&2; exit 1; }
all_answer "$A"

echo "==> k6: $RATE requests/s for $DURATION through the edge"
docker run -d --name "$K6" --network "container:$EDGE" \
  -v "$here/tests/load:/scripts:ro" \
  -e REHEARSAL_API=http://localhost -e REHEARSAL_RATE="$RATE" -e REHEARSAL_DURATION="$DURATION" \
  "$K6_IMAGE" run /scripts/no-downtime.k6.js >/dev/null
sleep 10

switches=ok
started=$(date +%s)
echo "==> Deploying $B during the load ($(date -u +%H:%M:%S))"
if deploy "$B" >"$LOGS/deploy-b.log" 2>&1; then
  echo "    deployed in $(($(date +%s) - started)) s ($(date -u +%H:%M:%S))"
  all_answer "$B" || switches=failed
else
  tail -n 40 "$LOGS/deploy-b.log" >&2
  switches=failed
fi
sleep 5
started=$(date +%s)
echo "==> Rolling back to $A during the load ($(date -u +%H:%M:%S))"
if rollback >"$LOGS/rollback.log" 2>&1; then
  echo "    rolled back in $(($(date +%s) - started)) s ($(date -u +%H:%M:%S))"
  all_answer "$A" || switches=failed
else
  tail -n 40 "$LOGS/rollback.log" >&2
  switches=failed
fi

# Both switches must finish inside the load, or the run proved less than it says.
if [[ "$(docker inspect -f '{{.State.Running}}' "$K6")" != true ]]; then
  echo "!! k6 finished before the rollback did: raise REHEARSAL_DURATION." >&2
  switches=failed
fi
k6_status=$(docker wait "$K6")
docker logs "$K6" >"$LOGS/k6.log" 2>&1
echo "==> k6 summary"
# The end-of-test summary, without the progress lines k6 prints every second.
grep -vE '^(running \(|reads +\[)' "$LOGS/k6.log" || true
# k6 judges only the served reads; readiness may answer 503 `draining` (the drain, by design) and
# nothing else.
draining=$(grep -c 'FAILED .* ready status=503 .*draining' "$LOGS/k6.log" || true)
unexpected=$(grep 'FAILED ' "$LOGS/k6.log" | grep -vc 'ready status=503 .*draining' || true)
echo "    readiness answered 503 draining $draining times; other failed requests: $unexpected"
((unexpected == 0)) || switches=failed

echo "==> Database connections (pg_stat_ssl)"
compose exec -T rehearsal-db psql -U rehearsal_admin -d tipme -c \
  "SELECT a.usename, s.ssl, s.version, count(*) FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid) WHERE a.usename LIKE 'tipme_%' GROUP BY 1, 2, 3 ORDER BY 1"

if [[ "$k6_status" == 0 && "$switches" == ok ]]; then
  echo "==> PASS: no served request failed; $A → $B → $A all seen in /health/release."
  exit 0
fi
echo "!! FAIL: k6 exit $k6_status, version switches $switches." >&2
exit 1
