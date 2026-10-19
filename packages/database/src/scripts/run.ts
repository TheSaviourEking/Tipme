import { createDatabase, type Database } from '../client.js';
import { assertLocalDatabaseUrl } from '../local-only.js';

/** Shared entry for local-only maintenance scripts. Errors print a message only (no URL). */
export async function runAgainstLocalDatabase(
  task: (db: Database) => Promise<void>,
): Promise<void> {
  const url = process.env['DATABASE_URL'];
  try {
    if (!url) throw new Error('DATABASE_URL is not set');
    assertLocalDatabaseUrl(url);
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
    return;
  }
  const handle = createDatabase(url, { max: 1 });
  try {
    await task(handle.db);
  } finally {
    await handle.close();
  }
}
