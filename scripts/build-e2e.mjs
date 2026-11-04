// Builds the stack for the browser suite with the lane's API origin baked into the web build
// (`pnpm test:e2e`). E2E_LANE unset or 0 is the original origin, http://127.0.0.1:4100.
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { laneConfig, writeLaneStamp } from '../tests/lane.mjs';

const { apiOrigin } = laneConfig();
const { status } = spawnSync('pnpm', ['build'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    NEXT_PUBLIC_API_ORIGIN: apiOrigin,
    NEXT_PUBLIC_PRETEND_DELIVERY: 'on',
  },
});
if (status === 0) writeLaneStamp(writeFileSync);
process.exit(status ?? 1);
