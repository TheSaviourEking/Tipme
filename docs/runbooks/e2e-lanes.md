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

- Always set a lane in a worktree that runs alongside others. Two runs on the same lane, including two
  that leave it unset, still collide.
- The database is the one in `DATABASE_URL` with only its name changed; `prepare-e2e-database` creates it
  and the run resets it. Lane databases are never dropped; drop them by hand when done.
- The build bakes the lane's API origin (`NEXT_PUBLIC_API_ORIGIN`) into the web app and records the lane in
  `apps/web/.next/lane.json`. Starting servers on a reused build (`review:screens --no-build`,
  `review:serve --no-build`) for a different lane stops with "apps/web/.next was built for lane X; E2E_LANE
  is Y. Rebuild (drop --no-build)." A reused build with no stamp is refused too.
- `TIPME_TEST_DATABASE`, which the lane sets, must be `tipme_test` or `tipme_test_laneN`; anything else is
  refused, because a run truncates every table in it.
- Playwright output goes to `test-results/lane<n>` for lanes above 0.
- CI does not set `E2E_LANE`, so it runs lane 0 exactly as before.
