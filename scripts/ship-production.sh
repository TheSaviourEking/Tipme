#!/usr/bin/env bash
# Ships one version to the production server and deploys it. Run by the deploy-production
# GitHub workflow after it has built the image; the same server also runs staging.
#
#   PRODUCTION_SSH=deploy@<server> scripts/ship-production.sh <version>
#
# Two things ship, in this order, and the first can stop the second:
#   1. The edge (deploy/edge): the one Caddy in front of both environments. Only this script
#      ever updates it (spec §6.1). The new Caddyfile is checked on the server with the
#      server's own edge.env; only a valid one replaces the running one and is reloaded. An
#      invalid one stops the ship here, before anything of production changes. A changed
#      compose.edge.yml is NOT applied (that would restart the edge, and with it staging):
#      the ship says so, and applying it is a runbook step.
#   2. This version's deploy files in /srv/tipme-production/releases/<version>/ and its image
#      (docker load over SSH), then deploy-production.sh from there. The server never builds.
#
# PRODUCTION_SKIP_DEPLOY=1 ships without running deploy-production.sh.
set -euo pipefail

version=${1:-}
[[ "$version" =~ ^[0-9a-f]{7,40}$ ]] || { echo "usage: ship-production.sh <version (git sha)>" >&2; exit 2; }
target=${PRODUCTION_SSH:?set PRODUCTION_SSH, e.g. deploy@203.0.113.10}
home=${PRODUCTION_HOME:-/srv/tipme-production}
edge=${PRODUCTION_EDGE_HOME:-/srv/tipme-edge}
ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
[[ -n "${PRODUCTION_SSH_KEY_FILE:-}" ]] && ssh_opts+=(-i "$PRODUCTION_SSH_KEY_FILE")
here=$(cd "$(dirname "$0")/.." && pwd)
release="$home/releases/$version"

echo "==> Copying the edge files"
tar -C "$here/deploy/edge" -cz Caddyfile compose.edge.yml |
  ssh "${ssh_opts[@]}" "$target" "mkdir -p '$edge/incoming' && tar -C '$edge/incoming' -xz"

echo "==> Checking the new Caddyfile on the server"
# The Caddyfile's {$...} placeholders come from edge.env, so the check gets the same file the
# running edge does. Any failure here (invalid file, missing setting) ends the ship.
ssh "${ssh_opts[@]}" "$target" "set -e
docker run --rm --env-file '$edge/edge.env' -v '$edge/incoming:/etc/caddy:ro' caddy:2.10.2-alpine \
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
if ! cmp -s '$edge/incoming/Caddyfile' '$edge/Caddyfile'; then
  # Kept so a failed reload can put the running config's file back; otherwise the next run
  # would find the disk and the incoming file equal and call it unchanged while the edge still
  # runs the old one. Staged beside the live file first, so a partial copy never reaches it.
  cp '$edge/Caddyfile' '$edge/Caddyfile.previous'
  cp '$edge/incoming/Caddyfile' '$edge/Caddyfile.new'
  # Written in place, not moved: the running container bind-mounts this one file, and a
  # replaced file would leave it reading the old copy.
  cat '$edge/Caddyfile.new' > '$edge/Caddyfile'
  rm -f '$edge/Caddyfile.new'
  if docker compose -p tipme-edge -f '$edge/compose.edge.yml' exec -T caddy caddy reload --config /etc/caddy/Caddyfile; then
    echo 'Caddyfile updated and reloaded.'
  else
    cat '$edge/Caddyfile.previous' > '$edge/Caddyfile'
    docker compose -p tipme-edge -f '$edge/compose.edge.yml' exec -T caddy caddy reload --config /etc/caddy/Caddyfile || echo 'The restored Caddyfile did not reload either: check the edge by hand.'
    echo 'ERROR: caddy reload failed; the previous Caddyfile is back in place. Production was not deployed.' >&2
    exit 1
  fi
else
  echo 'Caddyfile unchanged.'
fi
if ! cmp -s '$edge/incoming/compose.edge.yml' '$edge/compose.edge.yml'; then
  echo 'NOTICE: compose.edge.yml changed and was NOT applied (it would restart the edge).'
  echo \"Apply it by hand: cp '$edge/incoming/compose.edge.yml' '$edge/compose.edge.yml' && docker compose -p tipme-edge -f '$edge/compose.edge.yml' up -d\"
fi"

echo "==> Copying the production deploy files for $version"
tar -C "$here/deploy" -cz compose.production.yml scripts |
  ssh "${ssh_opts[@]}" "$target" "mkdir -p '$release' && tar -C '$release' -xz"

echo "==> Sending tipme-app:$version (compressed)"
docker save "tipme-app:$version" | gzip -1 | ssh "${ssh_opts[@]}" "$target" "gunzip | docker load"

if [[ "${PRODUCTION_SKIP_DEPLOY:-}" == "1" ]]; then
  echo "==> Shipped $version (deploy skipped)."
  exit 0
fi
echo "==> Deploying $version"
ssh "${ssh_opts[@]}" "$target" "bash '$release/scripts/deploy-production.sh' '$version'"
