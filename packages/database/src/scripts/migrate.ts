import { runMigrations } from '../migrations.js';
import { runAgainstLocalDatabase } from './run.js';

await runAgainstLocalDatabase(async (db) => {
  await runMigrations(db);
  console.log('Migrations applied.');
});
