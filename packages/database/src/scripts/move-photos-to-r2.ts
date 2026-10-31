import { createDatabase } from '../client.js';
import { movePhotosToStore } from '../operations/avatars.js';
import { createR2PhotoStore, r2Settings } from '../photo-store.js';

// Once, when R2 is switched on: copies page photos still in Postgres to the bucket and clears
// them from the table. Safe to run again. Prints no secrets.
const env = process.env;
const settings = r2Settings(env);
if (!settings) {
  console.error(
    'Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET first.',
  );
  process.exit(2);
}
const handle = createDatabase(env['DATABASE_URL'] ?? '', { max: 1 });
try {
  const moved = await movePhotosToStore(
    handle.db,
    createR2PhotoStore(settings),
  );
  console.log(`Moved ${moved} photo(s) to R2.`);
} catch (error) {
  console.error(
    `Moving photos failed: ${(error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`,
  );
  process.exitCode = 1;
} finally {
  await handle.close();
}
