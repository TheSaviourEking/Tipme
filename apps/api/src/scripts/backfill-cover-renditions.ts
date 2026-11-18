import {
  createDatabase,
  createR2PhotoStore,
  r2Settings,
} from '@tipme/database';
import { backfillCoverRenditions } from '../profiles/cover-backfill.js';

// Once, after the cover renditions release: gives covers uploaded before it their 640/1080/1600
// copies (docs/runbooks/photos.md). A dry run unless `--write`. Safe to run again. Uses the R2
// settings when set (covers kept there get their copies beside them). Prints no secrets.
//
//   node apps/api/dist/scripts/backfill-cover-renditions.js            (dry run)
//   node apps/api/dist/scripts/backfill-cover-renditions.js --write
const env = process.env;
const write = process.argv.includes('--write');
const settings = r2Settings(env);
const handle = createDatabase(env['DATABASE_URL'] ?? '', { max: 1 });
try {
  const result = await backfillCoverRenditions(handle.db, {
    write,
    store: settings ? createR2PhotoStore(settings) : undefined,
  });
  console.log(
    write
      ? `Added renditions to ${result.written} of ${result.candidates} cover(s); skipped ${result.skipped}.`
      : `Dry run: ${result.candidates} cover(s) have no renditions (${result.skipped} need the R2 settings). Run again with --write to add them.`,
  );
} catch (error) {
  console.error(
    `Backfilling cover renditions failed: ${(error as Error).message.replace(/postgres(ql)?:\/\/\S+/g, '<url>')}`,
  );
  process.exitCode = 1;
} finally {
  await handle.close();
}
