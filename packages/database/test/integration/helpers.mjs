import { openTestDatabase } from '../../dist/test-support.js';
import { seedDemoProfiles, DEMO_PROFILES } from '../../dist/index.js';

export const ADA = DEMO_PROFILES[0].id;
export const TOBI = DEMO_PROFILES[1].id;

/**
 * The plan rates of 12 Nov 2026 (Free 7%, Pro 5%), as a newer settings row. Since 18 Nov 2026 new
 * quotes default to Free 5% and Pro 3%; tests about shares, refunds and reversals, not about what
 * TipMe keeps, keep the figures they were written around this way (as atLaunchProPrice does for Pro).
 * Inserted after the 500/300 seed a reset re-inserts (test-support.ts), so it is the row in force (see fresh()).
 */
export const AT_12_NOV_PLAN_FEES = { planFees: { freeBps: 700, proBps: 500 } };

/** Opens the shared test database; each test starts from a reset, seeded state. */
export async function useDatabase(t, options = {}) {
  const database = await openTestDatabase();
  t.after(() => database.close());
  return {
    ...database,
    async fresh() {
      await database.reset();
      await seedDemoProfiles(database.db);
      // Two rows with the same rates: one dated long ago, so tests that quote at a fixed past `now`
      // (before the reset's seed) see them, and one in force exactly when the seed is, winning on
      // its later created_at. Not clock_timestamp(): a quote's `now` is a JS Date, whole
      // milliseconds, so a quote in the same millisecond as that insert read the row as not yet in
      // force and priced at the seed's 5% (seen in CI, share-transfers' lost-dispute test).
      if (options.planFees)
        await database.pool.query(
          `INSERT INTO plan_fee_rates (id, free_bps, pro_bps, effective_from, reason, created_at)
           VALUES (gen_random_uuid(), $1, $2, '2000-01-01T00:00:00Z',
                   'Test fixture: the 12 Nov 2026 rates (past)', clock_timestamp()),
                  (gen_random_uuid(), $1, $2,
                   (SELECT max(effective_from) FROM plan_fee_rates),
                   'Test fixture: the 12 Nov 2026 rates (with the seed)', clock_timestamp())`,
          [options.planFees.freeBps, options.planFees.proBps],
        );
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
