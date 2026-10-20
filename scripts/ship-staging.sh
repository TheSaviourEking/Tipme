#!/usr/bin/env bash
# Ships one version to the staging server and deploys it (PR-010). Run by the deploy-staging
# GitHub workflow after it has built and tested the image; also usable by hand from a machine
# that has the image (docker build -f deploy/Dockerfile -t tipme-app:<version> .).
#
#   STAGING_SSH=deploy@<server> scripts/ship-staging.sh <version>
#
# The server never builds or fetches code: it receives the image (docker load over SSH) and this
# version's deploy files in /srv/tipme/releases/<version>/, then runs deploy.sh from there.
set -euo pipefail

version=${1:-}
[[ "$version" =~ ^[0-9a-f]{7,40}$ ]] || { echo "usage: ship-staging.sh <version (git sha)>" >&2; exit 2; }
target=${STAGING_SSH:?set STAGING_SSH, e.g. deploy@203.0.113.10}
home=${STAGING_HOME:-/srv/tipme}
ssh_opts=(-o BatchMode=yes -o StrictHostKeyChecking=yes)
[[ -n "${STAGING_SSH_KEY_FILE:-}" ]] && ssh_opts+=(-i "$STAGING_SSH_KEY_FILE")
here=$(cd "$(dirname "$0")/.." && pwd)
release="$home/releases/$version"

echo "==> Copying the deploy files for $version"
tar -C "$here/deploy" -cz compose.staging.yml Caddyfile scripts |
  ssh "${ssh_opts[@]}" "$target" "mkdir -p '$release' && tar -C '$release' -xz"

echo "==> Sending tipme-app:$version (compressed)"
docker save "tipme-app:$version" | gzip -1 | ssh "${ssh_opts[@]}" "$target" "gunzip | docker load"

if [[ "${STAGING_SKIP_DEPLOY:-}" == "1" ]]; then
  echo "==> Shipped $version (deploy skipped)."
  exit 0
fi
echo "==> Deploying $version"
ssh "${ssh_opts[@]}" "$target" "bash '$release/scripts/deploy.sh' '$version'"
