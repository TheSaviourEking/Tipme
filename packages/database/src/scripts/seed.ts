import { seedDemoProfiles } from '../seed.js';
import { runAgainstLocalDatabase } from './run.js';

await runAgainstLocalDatabase(async (db) => {
  await seedDemoProfiles(db);
  console.log('Demo profiles seeded.');
});
