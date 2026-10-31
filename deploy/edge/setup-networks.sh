#!/usr/bin/env bash
# Creates the two networks the edge Caddy shares with staging and production. Safe to run again.
# The projects join them as external networks; each API answers on its own network only, so
# staging and production cannot reach each other through the edge.
set -euo pipefail
for network in edge-staging edge-production; do
  docker network inspect "$network" >/dev/null 2>&1 || docker network create "$network" >/dev/null
  echo "$network ready"
done
