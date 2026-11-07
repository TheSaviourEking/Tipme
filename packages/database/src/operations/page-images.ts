import { and, eq, isNotNull, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database, Tx } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import {
  businessLogos,
  profileAvatars,
  profileCovers,
  profiles,
} from '../schema.js';
import { OperationError } from './errors.js';

// What page photos and covers share. Not part of the package's public surface.

/**
 * Removes objects after the database change committed. A failure leaves an orphan that nothing
 * else can find (the row is gone and `PhotoStore` can't list), so the warning carries the object
 * key: that line is the only record, and docs/runbooks/photos.md says how to erase from it.
 * Chosen over a retry queue, which needs a table and a worker loop and so a migration; revisit if
 * failures turn up in practice. The key is `<kind>/<page id>/<random>.webp`: opaque ids, with no
 * handle, name or email in it. This package isn't handed a logger.
 */
export async function removeObjects(
  store: PhotoStore | undefined,
  keys: string[],
) {
  if (!store) return;
  for (const key of keys)
    await store.remove(key).catch(() => {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'photo_object.remove_failed',
          kind: key.split('/')[0],
          objectKey: key,
        }),
      );
    });
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
 * Locks the page for the rest of the transaction, so an image can't land on a page deleted since
 * the upload began, and uploads to one page take turns (a row lock can't: there may be no row yet).
 */
export async function lockLivePage(tx: Tx, profileId: string) {
  const [page] = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.id, profileId), ne(profiles.pageState, 'deleted')))
    .for('update');
  if (!page) throw new OperationError('NO_PAGE');
}

/** A table of stored images: one row per owner (a page or a business), bytes or an object key. */
type ImageTable =
  typeof profileAvatars | typeof profileCovers | typeof businessLogos;
const ownerOf = (table: ImageTable) =>
  'businessId' in table ? table.businessId : table.profileId;

/**
 * Copies one table's images from Postgres to the object store and clears them from the table,
 * one at a time: covers are too big to hold them all in memory. Each row changes only if its image
 * is the one copied, so an image replaced meanwhile wins.
 */
export async function moveRowsToStore(
  db: Database,
  store: PhotoStore,
  table: ImageTable,
  prefix: 'avatars' | 'covers' | 'logos',
): Promise<number> {
  const owner = ownerOf(table);
  const owners = await db
    .select({ id: owner })
    .from(table)
    .where(isNotNull(table.bytes));
  let moved = 0;
  for (const { id } of owners) {
    const [row] = await db
      .select({ version: table.version, bytes: table.bytes })
      .from(table)
      .where(and(eq(owner, id), isNotNull(table.bytes)));
    if (!row) continue;
    const objectKey = `${prefix}/${id}/${randomUUID()}.webp`;
    await store.put(objectKey, row.bytes!);
    const updated = await db
      .update(table)
      .set({ bytes: null, objectKey })
      .where(
        and(
          eq(owner, id),
          eq(table.version, row.version),
          isNotNull(table.bytes),
        ),
      )
      .returning({ id: owner });
    if (updated.length) moved += 1;
    else await removeObjects(store, [objectKey]);
  }
  return moved;
}
