import { createDatabase, type Database } from '../client.js';
import { assertLocalDatabaseUrl } from '../local-only.js';

/** Shared entry for local-only maintenance scripts. Errors print a message only (no URL). */
export async function runAgainstLocalDatabase(
  task: (db: Database) => Promise<void>,
  options: { allowNamedServerDatabase?: boolean } = {},
): Promise<void> {
  const url = process.env['DATABASE_URL'];
  try {
    if (!url) throw new Error('DATABASE_URL is not set');
    try {
      assertLocalDatabaseUrl(url);
    } catch (local) {
      if (!options.allowNamedServerDatabase) throw local;
      // A server database (staging, inside its container) only when named on purpose (PR-010).
      const name = decodeURIComponent(new URL(url).pathname.replace(/^\//, ''));
      const confirm = process.env['TIPME_CONFIRM_DATABASE'];
      if (!confirm || confirm !== name)
        throw new Error(
          `${(local as Error).message}. To run against it on purpose, set TIPME_CONFIRM_DATABASE to its database name.`,
        );
    }
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
