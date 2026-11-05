import { laneConfig } from '../tests/lane.mjs';

// Each E2E_LANE has its own database (tests/lane.ts), so concurrent worktrees never reset each other's.
process.env.TIPME_TEST_DATABASE = laneConfig().databaseName;
const { openTestDatabase } =
  await import('../packages/database/dist/test-support.js');

// Playwright starts the API before its global setup. /health/ready runs SELECT 1
// against the lane's database (tipme_test for lane 0), so it has to exist before the servers start.
const database = await openTestDatabase();
await database.close();
