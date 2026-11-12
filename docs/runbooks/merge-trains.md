# Runbook: merging pull requests into dev (merge trains)

Several pull requests are often ready at once. These rules keep them from breaking `dev` or each other
through conflicts in generated files.

## Rules

1. **API changes land one at a time, or in one merge train.** A PR that changes the API regenerates the
   OpenAPI document (`pnpm api:openapi`) and the generated docs, access control included (`pnpm docs:generate`). Two such PRs both regenerate the
   same files, so they conflict, and a hand-merged generated file is wrong. Merge them in sequence (the
   next one updates from `dev` and regenerates after the previous one lands), or put them in one merge
   train branch, regenerated once at the end with the repo's commands (`--check` must pass).
2. **A PR joins a train only after its own CI is green.** A train is not a way to land a red PR: a
   failure inside a train blocks every PR in it and is harder to trace.
3. **Check against the latest dev before calling a PR ready.** Update the branch from the current `dev`
   (merge, never force-push someone else's branch), rerun the generated-file checks and the specs it
   touches, and let CI pass on that commit. "Green last week" is not ready.

## A train, step by step

1. List the PRs to land and their order. API-changing PRs go together or one after another.
2. Confirm each PR's own CI is green on its latest commit.
3. Create the train branch from the latest `dev`; merge each PR's branch in order.
4. Regenerate OpenAPI / access-control docs once, run their `--check`, and commit.
5. Open the train PR into `dev`; it must pass every CI job (including `e2e-burn-in`) before merging.
