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

/**
 * Puts the Pro price back at the ₦2,500 these tests were written around, as a newer price row
 * (prices are history and refuse edits). Since 12 Nov 2026 a reset leaves ₦5,000 (migration 0093);
 * tests about how Pro is paid, not what it costs, keep their figures this way.
 */
export async function atLaunchProPrice(database) {
  await database.pool.query(
    `INSERT INTO pro_prices (id, amount_minor, currency, effective_from, reason, created_at)
     VALUES (gen_random_uuid(), 250000, 'NGN', clock_timestamp(), 'Test fixture: the launch price', clock_timestamp())`,
  );
}
