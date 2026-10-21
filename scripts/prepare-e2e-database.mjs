import { openTestDatabase } from '../packages/database/dist/test-support.js';

// Playwright starts the API before its global setup. /health/ready runs SELECT 1
// against tipme_test, so that database has to exist before the servers start.
const database = await openTestDatabase();
await database.close();
