import {
  addCoverRenditions,
  coversWithoutRenditions,
  storedCover,
  type Database,
  type PhotoStore,
} from '@tipme/database';
import { withSlot } from './image-upload.js';
import { coverRenditionsOf } from './cover-renditions.js';

// Renditions for covers uploaded before they existed (scripts/backfill-cover-renditions.ts): the
// wide copies, the tall crop, or both, whichever a cover lacks. Until it runs, those covers simply
// report none and pages use the full file: nothing breaks.

export interface BackfillResult {
  write: boolean;
  /** Covers missing the wide copies or the tall crop when the run started. */
  candidates: number;
  written: number;
  /** In the object store with no store given, unreadable, or replaced meanwhile. */
  skipped: number;
}

/**
 * Dry run unless `write`: then each cover gets the shapes of rendition it lacks, where it is kept.
 * Safe to run again: a shape a cover has is never touched. Lines name pages by id only.
 */
export async function backfillCoverRenditions(
  db: Database,
  options: {
    write?: boolean;
    store?: PhotoStore | undefined;
    log?: (line: string) => void;
  } = {},
): Promise<BackfillResult> {
  const write = options.write === true;
  const log = options.log ?? ((line: string) => console.log(line));
  const covers = await coversWithoutRenditions(db);
  const result: BackfillResult = {
    write,
    candidates: covers.length,
    written: 0,
    skipped: 0,
  };
  for (const cover of covers) {
    const label = `page ${cover.profileId} cover v${cover.version}`;
    const lacks = cover.missing.join(' and ');
    if (cover.inStore && !options.store) {
      log(`${label}: skipped, in the object store (set the R2 settings)`);
      result.skipped += 1;
      continue;
    }
    if (!write) {
      log(`${label}: would add ${lacks}`);
      continue;
    }
    const bytes = await storedCover(db, cover, options.store);
    if (!bytes) {
      log(`${label}: skipped, its file could not be read`);
      result.skipped += 1;
      continue;
    }
    let renditions;
    try {
      renditions = (await withSlot(() => coverRenditionsOf(bytes))).filter(
        (r) => cover.missing.includes(r.shape),
      );
    } catch {
      log(`${label}: skipped, its file is not a readable WebP`);
      result.skipped += 1;
      continue;
    }
    if (!renditions.length) {
      log(`${label}: skipped, narrower than every rendition`);
      result.skipped += 1;
      continue;
    }
    const added = await addCoverRenditions(
      db,
      { ...cover, renditions },
      options.store,
      // Before each write: if the run is killed mid-cover, these name the objects to delete.
      (key) => log(`${label}: writing ${key}`),
    );
    if (added) {
      result.written += 1;
      log(
        `${label}: added ${renditions.map((r) => `${r.shape === 'tall' ? 'tall ' : ''}${r.width} (${r.webp.length} B)`).join(', ')}`,
      );
    } else {
      result.skipped += 1;
      log(`${label}: skipped, changed meanwhile`);
    }
  }
  return result;
}
