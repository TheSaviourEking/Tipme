import { randomUUID } from 'node:crypto';
import type { CoverDesignChoice, MyProfile } from '@tipme/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import { profileCovers, profiles } from '../schema.js';
import { guarded } from './errors.js';
import { myPageId, removeObjects } from './page-images.js';
import { getMyProfile } from './profiles.js';

// Page covers. Stored and served exactly as page photos are (see avatars.ts): the bytes are
// always the server's own re-encoding, and an object is written before its row and removed after
// its row is gone.

export const coverPathOf = (profileId: string, version: number) =>
  `/v1/covers/${profileId}/${version}.webp`;

/** Replaces the page's cover with already re-encoded WebP bytes; a new version, a new URL. */
export function setCover(
  db: Database,
  userId: string,
  webp: Buffer,
  store?: PhotoStore,
): Promise<MyProfile> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    // Uploaded first: if this fails, nothing in the database changed.
    const objectKey = store ? `covers/${profileId}/${randomUUID()}.webp` : null;
    if (store && objectKey) await store.put(objectKey, webp);
    let previous: string | null = null;
    try {
      await db.transaction(async (tx) => {
        const [old] = await tx
          .select({ objectKey: profileCovers.objectKey })
          .from(profileCovers)
          .where(eq(profileCovers.profileId, profileId))
          .for('update');
        previous = old?.objectKey ?? null;
        // The page's counter, never the cover row's: removing a cover deletes the row, and the
        // next cover must still get a URL no cache has seen.
        const [next] = await tx
          .update(profiles)
          .set({ coverVersion: sql`${profiles.coverVersion} + 1` })
          .where(eq(profiles.id, profileId))
          .returning({ version: profiles.coverVersion });
        const version = next!.version;
        const stored = objectKey
          ? { bytes: null, objectKey }
          : { bytes: webp, objectKey: null };
        await tx
          .insert(profileCovers)
          .values({ profileId, version, ...stored })
          .onConflictDoUpdate({
            target: profileCovers.profileId,
            set: { version, ...stored, createdAt: sql`now()` },
          });
        await tx
          .update(profiles)
          .set({ coverPath: coverPathOf(profileId, version) })
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

/** Removes the page's uploaded cover: its URL stops working, and any chosen design shows again. */
export function removeCover(
  db: Database,
  userId: string,
  store?: PhotoStore,
): Promise<MyProfile> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const removed = await db.transaction(async (tx) => {
      const rows = await tx
        .delete(profileCovers)
        .where(eq(profileCovers.profileId, profileId))
        .returning({ objectKey: profileCovers.objectKey });
      await tx
        .update(profiles)
        .set({ coverPath: null })
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
 * Records the chosen design and colour, already checked against the catalogue by
 * `coverDesignChoiceSchema`. An uploaded cover is left alone: it keeps winning until it's removed,
 * and then this choice shows. `design: null` clears the choice.
 */
export function setCoverDesign(
  db: Database,
  userId: string,
  choice: CoverDesignChoice,
): Promise<MyProfile> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    await db
      .update(profiles)
      .set({ coverDesign: choice.design, coverColour: choice.colour ?? null })
      .where(eq(profiles.id, profileId));
    return getMyProfile(db, userId);
  });
}

/**
 * A cover to serve: only the current version, and only while the page is live and not paused
 * (a hidden page's cover is as unavailable as the page itself).
 */
export function coverFor(
  db: Database,
  input: { profileId: string; version: number },
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    const [row] = await db
      .select({
        bytes: profileCovers.bytes,
        objectKey: profileCovers.objectKey,
      })
      .from(profileCovers)
      .innerJoin(profiles, eq(profiles.id, profileCovers.profileId))
      .where(
        and(
          eq(profileCovers.profileId, input.profileId),
          eq(profileCovers.version, input.version),
          eq(profiles.pageState, 'live'),
          eq(profiles.status, 'active'),
        ),
      );
    if (!row) return null;
    if (row.bytes) return row.bytes;
    return row.objectKey && store ? store.get(row.objectKey) : null;
  });
}
