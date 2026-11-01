import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import { profileAvatars, profileCovers, profiles } from '../schema.js';
import { OperationError } from './errors.js';

// What page photos and covers share. Not part of the package's public surface.

/** Removes objects after the database change committed; a failure only leaves an orphan. */
export async function removeObjects(
  store: PhotoStore | undefined,
  keys: string[],
) {
  if (!store) return;
  for (const key of keys) await store.remove(key).catch(() => undefined);
}

export async function myPageId(db: Database, userId: string) {
  const [page] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.userId, userId), ne(profiles.pageState, 'deleted')));
  if (!page) throw new OperationError('NO_PAGE');
  return page.id;
}

/**
 * Copies one table's images from Postgres to the object store and clears them from the table.
 * Each row changes only if its image is the one copied, so an image replaced meanwhile wins.
 */
export async function moveRowsToStore(
  db: Database,
  store: PhotoStore,
  table: typeof profileAvatars | typeof profileCovers,
  prefix: 'avatars' | 'covers',
): Promise<number> {
  const rows = await db
    .select({
      profileId: table.profileId,
      version: table.version,
      bytes: table.bytes,
    })
    .from(table)
    .where(isNotNull(table.bytes));
  let moved = 0;
  for (const row of rows) {
    const objectKey = `${prefix}/${row.profileId}/${randomUUID()}.webp`;
    await store.put(objectKey, row.bytes!);
    const updated = await db
      .update(table)
      .set({ bytes: null, objectKey })
      .where(
        and(
          eq(table.profileId, row.profileId),
          eq(table.version, row.version),
          isNotNull(table.bytes),
        ),
      )
      .returning({ profileId: table.profileId });
    if (updated.length) moved += 1;
    else await removeObjects(store, [objectKey]);
  }
  return moved;
}
