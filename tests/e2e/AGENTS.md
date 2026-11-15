# AGENTS.md — browser (e2e) tests

Rules for `tests/e2e`. They come from failures that passed on a Mac and failed in CI, or passed alone and
failed beside other tests.

## Writing tests

- **Scope text to a region.** Find text inside a role or region (alert, card, dialog, `main`, `nav`), never
  page-wide words that shared data could repeat.
- **Never assume a shared list is empty.** Other tests write to the same database at the same time. Look
  for your own row (your identity, handle or email), not for "the first row" or a count.
- **Wait for end states, not clicks.** After an action, wait for its result (URL, element, text). A click
  returning proves nothing. `signInWithEmail` returns only once signed in (or once the code is refused).
- **Hold network answers to avoid timer races.** When a test needs an in-between state (busy, retrying, a
  toast that times out), `page.route` the request and answer it when the test is ready, rather than
  hoping a timer hasn't fired yet.
- **Live updates.** Any test routing `**/v1/me/**` must answer `/v1/me/events` with 204.
- **Measure layout with `document.documentElement.clientWidth`, never `innerWidth`.** Linux Chromium
  has a scrollbar gutter that `innerWidth` includes and a Mac doesn't, so an `innerWidth` check passes on a
  Mac and fails in CI.
- **Use the lane.** Set `E2E_LANE` in a worktree ([lanes](../../docs/runbooks/e2e-lanes.md)). Run the
  specs you add or touch, not the whole suite; CI runs everything.

## What CI does with a changed spec

On a pull request, the `e2e-burn-in` job runs every spec file the PR adds or changes five times, with no
retries (`--repeat-each=5 --retries=0`). One failure in those runs fails the PR. Do the same locally before
pushing:

```sh
E2E_LANE=4 pnpm exec playwright test tests/e2e/my.spec.ts --repeat-each=5 --retries=0 --workers=2
```

## Checking on Linux before pushing

`scripts/e2e-linux.sh` runs spec files with Linux Chromium from the official Playwright Docker image (the
repo's Playwright version), to catch Linux-only differences (scrollbar gutters, fonts) on a Mac.

```sh
rm -rf apps/web/.next && E2E_LANE=4 TURBO_FORCE=true node scripts/build-e2e.mjs
E2E_LANE=4 node scripts/prepare-e2e-database.mjs
E2E_LANE=4 scripts/e2e-linux.sh tests/e2e/dialogs.spec.ts --workers=2
```

Only the browser runs in Docker. The test runner, web, API and worker run on the Mac as usual; the browser
reaches them through Playwright's own connection (`PW_TEST_CONNECT_EXPOSE_NETWORK=<loopback>`), so
`127.0.0.1` inside the browser is the Mac. That avoids `--network host` (not on Docker for Mac) and
`host.docker.internal` rewrites. It needs Docker running; the first run pulls a large image.
