# Running the browser suite in parallel lanes

Two or three worktrees can run `pnpm test:e2e` at the same time. Each picks a lane with `E2E_LANE`; every
value that would collide comes from `tests/lane.ts` (scripts use the twin `tests/lane.mjs`).

| Lane          | Web  | API  | Database           | Redis db       | Queue prefix |
| ------------- | ---- | ---- | ------------------ | -------------- | ------------ |
| 0 (unset), CI | 3100 | 4100 | `tipme_test`       | as `REDIS_URL` | `e2e`        |
| 1             | 3110 | 4110 | `tipme_test_lane1` | 2              | `e2e-lane1`  |
| 2             | 3120 | 4120 | `tipme_test_lane2` | 3              | `e2e-lane2`  |

```sh
E2E_LANE=1 pnpm test:e2e -- tests/e2e/quality.spec.ts --project=desktop
E2E_LANE=2 pnpm review:screens
```

- Give each concurrent worktree its own lane. Two runs on the same lane still collide.
- The database is the one in `DATABASE_URL` with only its name changed; `prepare-e2e-database` creates it
  and the run resets it. Lane databases are never dropped; drop them by hand when done.
- The build bakes the lane's API origin (`NEXT_PUBLIC_API_ORIGIN`) into the web app, so each worktree's
  `.next` matches its lane. Do not reuse a `.next` built for another lane.
- Playwright output goes to `test-results/lane<n>` for lanes above 0.
- CI does not set `E2E_LANE`, so it runs lane 0 exactly as before.
