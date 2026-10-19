import { openTestDatabase } from '../../dist/test-support.js';
import { seedDemoProfiles, DEMO_PROFILES } from '../../dist/index.js';

export const ADA = DEMO_PROFILES[0].id;
export const TOBI = DEMO_PROFILES[1].id;

/** Opens the shared test database; each test starts from a reset, seeded state. */
export async function useDatabase(t) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  return {
    ...database,
    async fresh() {
      await database.reset();
      await seedDemoProfiles(database.db);
    },
    async count(table) {
      return (
        await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)
      ).rows[0].n;
    },
  };
}
