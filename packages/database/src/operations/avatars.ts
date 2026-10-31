import { randomUUID } from 'node:crypto';
import type { MyProfile } from '@tipme/contracts';
import { and, eq, isNotNull, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import { profileAvatars, profiles } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { getMyProfile } from './profiles.js';

// Profile photos (PR-013). The bytes stored here are always the server's own re-encoding
// (the API never stores an upload as sent); this module only keeps and serves them. With an
// object store (R2) the photo lives there and the row keeps only its key; without one, in
// Postgres as before. An object is written before its row and removed after its row is gone,
// so a served URL never points at a missing object; a crash between the two can leave an
// unreferenced object behind, never a broken photo.

/** Removes objects after the database change committed; a failure only leaves an orphan. */
async function removeObjects(store: PhotoStore | undefined, keys: string[]) {
  if (!store) return;
  for (const key of keys) await store.remove(key).catch(() => undefined);
}

export const avatarPathOf = (profileId: string, version: number) =>
  `/v1/avatars/${profileId}/${version}.webp`;

async function myPageId(db: Database, userId: string) {
  const [page] = await db
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.userId, userId), ne(profiles.pageState, 'deleted')));
  if (!page) throw new OperationError('NO_PAGE');
  return page.id;
}

/** Replaces the page's photo with already re-encoded WebP bytes; a new version, a new URL. */
export function setAvatar(
  db: Database,
  userId: string,
  webp: Buffer,
  store?: PhotoStore,
): Promise<MyProfile> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    // Uploaded first: if this fails, nothing in the database changed.
    const objectKey = store
      ? `avatars/${profileId}/${randomUUID()}.webp`
      : null;
    if (store && objectKey) await store.put(objectKey, webp);
    let previous: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [old] = await tx
          .select({ objectKey: profileAvatars.objectKey })
          .from(profileAvatars)
          .where(eq(profileAvatars.profileId, profileId))
          .for('update');
        previous = old?.objectKey ?? null;
        // The page's counter, never the photo row's: removing a photo deletes the row, and the
        // next photo must still get a URL no cache has seen.
        const [next] = await tx
          .update(profiles)
          .set({ avatarVersion: sql`${profiles.avatarVersion} + 1` })
          .where(eq(profiles.id, profileId))
          .returning({ version: profiles.avatarVersion });
        const version = next!.version;
        const stored = objectKey
          ? { bytes: null, objectKey }
          : { bytes: webp, objectKey: null };
        await tx
          .insert(profileAvatars)
          .values({ profileId, version, ...stored })
          .onConflictDoUpdate({
            target: profileAvatars.profileId,
            set: { version, ...stored, createdAt: sql`now()` },
          });
        await tx
          .update(profiles)
          .set({ avatarPath: avatarPathOf(profileId, version) })
          .where(eq(profiles.id, profileId));
      });
    } catch (error) {
      if (objectKey) await removeObjects(store, [objectKey]);
      throw error;
    }
    if (previous) await removeObjects(store, [previous]);
    return getMyProfile(db, userId);
  });
}

/** Removes the page's photo: its URL stops working at once. */
export function removeAvatar(
  db: Database,
  userId: string,
  store?: PhotoStore,
): Promise<MyProfile> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const removed = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(profileAvatars)
        .where(eq(profileAvatars.profileId, profileId))
        .returning({ objectKey: profileAvatars.objectKey });
      await tx
        .update(profiles)
        .set({ avatarPath: null })
        .where(eq(profiles.id, profileId));
      return rows;
    });
    await removeObjects(
      store,
      removed.flatMap((r) => (r.objectKey ? [r.objectKey] : [])),
    );
    return getMyProfile(db, userId);
  });
}

/**
 * A photo to serve: only the current version, and only while the page is live and not paused
 * (a hidden page's photo is as unavailable as the page itself).
 */
export function avatarFor(
  db: Database,
  input: { profileId: string; version: number },
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        bytes: profileAvatars.bytes,
        objectKey: profileAvatars.objectKey,
      })
      .from(profileAvatars)
      .innerJoin(profiles, eq(profiles.id, profileAvatars.profileId))
      .where(
        and(
          eq(profileAvatars.profileId, input.profileId),
          eq(profileAvatars.version, input.version),
          eq(profiles.pageState, 'live'),
          eq(profiles.status, 'active'),
        ),
      );
    if (!row) return null;
    if (row.bytes) return row.bytes;
    return row.objectKey && store ? store.get(row.objectKey) : null;
  });
}

/**
 * Moves photos still kept in Postgres to the object store (once, when R2 is switched on).
 * Each row changes only if its photo is the one copied, so a photo replaced meanwhile wins.
 */
export function movePhotosToStore(
  db: Database,
  store: PhotoStore,
): Promise<number> {
  return guarded(async () => {
    const rows = await db
      .select({
        profileId: profileAvatars.profileId,
        version: profileAvatars.version,
        bytes: profileAvatars.bytes,
      })
      .from(profileAvatars)
      .where(isNotNull(profileAvatars.bytes));
    let moved = 0;
    for (const row of rows) {
      const objectKey = `avatars/${row.profileId}/${randomUUID()}.webp`;
      await store.put(objectKey, row.bytes!);
      const updated = await db
        .update(profileAvatars)
        .set({ bytes: null, objectKey })
        .where(
          and(
            eq(profileAvatars.profileId, row.profileId),
            eq(profileAvatars.version, row.version),
            isNotNull(profileAvatars.bytes),
          ),
        )
        .returning({ profileId: profileAvatars.profileId });
      if (updated.length) moved += 1;
      else await removeObjects(store, [objectKey]);
    }
    return moved;
  });
}
