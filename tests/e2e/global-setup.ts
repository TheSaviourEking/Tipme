import { E2E_DATABASE_URL } from './stack';

/** Fresh, migrated and seeded `tipme_test` before the servers start taking tips. */
export default async function globalSetup() {
  const { openTestDatabase } =
    await import('../../packages/database/dist/test-support.js');
  const { seedDemoProfiles } =
    await import('../../packages/database/dist/index.js');
  const database = await openTestDatabase();
  try {
    if (database.url !== E2E_DATABASE_URL)
      throw new Error('e2e must use the tipme_test database');
    // The worker is already running, and its first sweep can deadlock with the reset's TRUNCATE.
    for (let tries = 3; ; tries -= 1) {
      try {
        await database.reset();
        break;
      } catch (error) {
        const deadlock = (error as { code?: string }).code === '40P01';
        if (!deadlock || tries <= 1) throw error;
      }
    }
    await seedDemoProfiles(database.db);
  } finally {
    await database.close();
  }
}
