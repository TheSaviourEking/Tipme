import { and, asc, eq, isNotNull, ne } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Database, Tx } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import {
  businessLogos,
  profileAvatars,
  profileCoverRenditions,
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

/** A cover rendition's shape: a same-shape smaller copy, or the 4:5 tall crop. */
export type CoverRenditionShape = 'wide' | 'tall';

/**
 * Where a cover's rendition is kept in the object store: beside the cover, under the same page
 * (`covers/<page>/<random>-640-<salt>.webp`, or `<random>-tall-480-<salt>.webp` for a tall crop).
 * The salt makes every write a new key, so removing the objects of a write that lost a race can
 * never remove another write's.
 */
export const renditionKeyOf = (
  coverKey: string,
  width: number,
  salt: string,
  shape: CoverRenditionShape = 'wide',
) =>
  `${coverKey.replace(/\.webp$/, '')}-${shape === 'tall' ? 'tall-' : ''}${width}-${salt}.webp`;
export const newRenditionSalt = () => randomUUID().slice(0, 8);

/**
 * Deletes a page's cover renditions in this transaction and returns their object keys, to remove
 * after the commit. Every path that removes or replaces a cover calls this before the cover row
 * goes: the foreign key cascades too, but a cascade can't say which objects to remove.
 */
export async function deleteCoverRenditions(
  tx: Tx,
  profileId: string,
): Promise<string[]> {
  const rows = await tx
    .delete(profileCoverRenditions)
    .where(eq(profileCoverRenditions.profileId, profileId))
    .returning({ objectKey: profileCoverRenditions.objectKey });
  return rows.flatMap((r) => (r.objectKey ? [r.objectKey] : []));
}

/**
 * The renditions stored for the page's current cover, narrowest first, by shape, as `resolveCover`
 * takes them; none for an older cover.
 */
export async function coverWidthsOf(
  db: Database | Tx,
  profileId: string,
): Promise<{ coverWidths: number[]; coverTall: number[] }> {
  const rows = await db
    .select({
      shape: profileCoverRenditions.shape,
      width: profileCoverRenditions.width,
    })
    .from(profileCoverRenditions)
    .innerJoin(
      profileCovers,
      and(
        eq(profileCovers.profileId, profileCoverRenditions.profileId),
        eq(profileCovers.version, profileCoverRenditions.version),
      ),
    )
    .where(eq(profileCoverRenditions.profileId, profileId))
    .orderBy(asc(profileCoverRenditions.width));
  return {
    coverWidths: rows.filter((r) => r.shape === 'wide').map((r) => r.width),
    coverTall: rows.filter((r) => r.shape === 'tall').map((r) => r.width),
  };
}

/**
 * After covers moved to the store: moves each rendition still in Postgres to a key beside its
 * cover, one at a time. A rendition whose cover is still in Postgres (it lost a race) waits for the
 * next run. Each row changes only if it is still the one copied.
 */
export async function moveRenditionsToStore(
  db: Database,
  store: PhotoStore,
): Promise<number> {
  const waiting = await db
    .select({
      profileId: profileCoverRenditions.profileId,
      shape: profileCoverRenditions.shape,
      width: profileCoverRenditions.width,
    })
    .from(profileCoverRenditions)
    .where(isNotNull(profileCoverRenditions.bytes));
  let moved = 0;
  for (const { profileId, shape, width } of waiting) {
    const [row] = await db
      .select({
        version: profileCoverRenditions.version,
        bytes: profileCoverRenditions.bytes,
        coverKey: profileCovers.objectKey,
      })
      .from(profileCoverRenditions)
      .innerJoin(
        profileCovers,
        and(
          eq(profileCovers.profileId, profileCoverRenditions.profileId),
          eq(profileCovers.version, profileCoverRenditions.version),
        ),
      )
      .where(
        and(
          eq(profileCoverRenditions.profileId, profileId),
          eq(profileCoverRenditions.shape, shape),
          eq(profileCoverRenditions.width, width),
          isNotNull(profileCoverRenditions.bytes),
          isNotNull(profileCovers.objectKey),
        ),
      );
    if (!row?.coverKey) continue;
    const objectKey = renditionKeyOf(
      row.coverKey,
      width,
      newRenditionSalt(),
      shape as CoverRenditionShape,
    );
    await store.put(objectKey, row.bytes!);
    const updated = await db
      .update(profileCoverRenditions)
      .set({ bytes: null, objectKey })
      .where(
        and(
          eq(profileCoverRenditions.profileId, profileId),
          eq(profileCoverRenditions.shape, shape),
          eq(profileCoverRenditions.width, width),
          eq(profileCoverRenditions.version, row.version),
          isNotNull(profileCoverRenditions.bytes),
        ),
      )
      .returning({ width: profileCoverRenditions.width });
    if (updated.length) moved += 1;
    else await removeObjects(store, [objectKey]);
  }
  return moved;
}
