#!/usr/bin/env bash
# Runs e2e spec files with a Linux Chromium (the official Playwright Docker image, same version as
# the repo's @playwright/test), so failures CI sees and a Mac doesn't (scrollbar gutters, fonts) show
# up before pushing.
#
#   E2E_LANE=4 scripts/e2e-linux.sh tests/e2e/dialogs.spec.ts [more files or Playwright flags]
#
# Only the browser runs in Docker. The test runner, web, API and worker run on this machine as in a
# normal run (playwright.config.ts starts them), and the browser reaches them through Playwright's
# connection (exposeNetwork '<loopback>'), so 127.0.0.1 in the browser is this machine: no
# --network host (not on Docker for Mac) and no host.docker.internal rewrites.
#
# Needs: Docker running; a lane build (`TURBO_FORCE=true node scripts/build-e2e.mjs`) and database
# (`node scripts/prepare-e2e-database.mjs`) for the same E2E_LANE, as `pnpm test:e2e` makes.
set -euo pipefail

cd "$(dirname "$0")/.."
if [ "$#" -eq 0 ]; then
  echo "usage: E2E_LANE=<n> scripts/e2e-linux.sh <spec files> [playwright flags]" >&2
  exit 2
fi

version=$(node -p "require('@playwright/test/package.json').version")
image="mcr.microsoft.com/playwright:v${version}-noble"
lane="${E2E_LANE:-0}"
# One port and container per lane, so lanes can run side by side.
port=$((3600 + lane))
name="tipme-e2e-linux-lane${lane}"

# Pulled on its own first, so a slow or failing download says so instead of looking like a hang.
if ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Pulling ${image} (large; first run only)…"
  docker pull "$image"
fi
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --rm --init --name "$name" -p "127.0.0.1:${port}:${port}" \
  --workdir /home/pwuser --user pwuser "$image" \
  /bin/sh -c "npx -y playwright@${version} run-server --port ${port} --host 0.0.0.0" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

# The server prints its address once it accepts connections.
for _ in $(seq 1 120); do
  if docker logs "$name" 2>&1 | grep -q "Listening on"; then break; fi
  if ! docker inspect "$name" >/dev/null 2>&1; then
    echo "The Playwright container stopped before listening." >&2
    exit 1
  fi
  sleep 1
done
docker logs "$name" 2>&1 | grep -q "Listening on" || {
  echo "The Playwright server did not start within 120s:" >&2
  docker logs "$name" >&2
  exit 1
}

echo "Linux Chromium: ${image} (lane ${lane}, ws://127.0.0.1:${port}/)"
PW_TEST_CONNECT_WS_ENDPOINT="ws://127.0.0.1:${port}/" \
  PW_TEST_CONNECT_EXPOSE_NETWORK='<loopback>' \
  pnpm exec node scripts/run-e2e.mjs "$@"
