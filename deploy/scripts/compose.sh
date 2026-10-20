#!/usr/bin/env bash
# docker compose for the running staging version, with the server's settings (PR-010).
#   /srv/tipme/live/scripts/compose.sh ps
#   /srv/tipme/live/scripts/compose.sh run --rm backup sh deploy/backup-loop.sh once
set -euo pipefail
source "$(dirname "$0")/lib.sh"
version=$(current_version)
[[ -n "$version" ]] || { echo "Nothing deployed yet." >&2; exit 2; }
compose_for "$version" "$@"
