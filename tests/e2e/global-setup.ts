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
    await database.reset();
    await seedDemoProfiles(database.db);
  } finally {
    await database.close();
  }
}
