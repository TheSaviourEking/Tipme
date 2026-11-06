import { randomUUID } from 'node:crypto';
import {
  coverChoiceNeedsPro,
  type CoverDesignChoice,
  type MyProfile,
} from '@tipme/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import { profileCovers, profiles } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { lockLivePage, myPageId, removeObjects } from './page-images.js';
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
        await lockLivePage(tx, profileId);
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

/**
 * Removes the page's uploaded cover: its URL stops working, and any chosen design shows again.
 * `changed` is false when there was no cover, so the caller has nothing to refresh.
 */
export function removeCover(
  db: Database,
  userId: string,
  store?: PhotoStore,
): Promise<{ profile: MyProfile; changed: boolean }> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const removed = await db.transaction(async (tx) => {
      await lockLivePage(tx, profileId);
      const rows = await tx
        .delete(profileCovers)
        .where(eq(profileCovers.profileId, profileId))
        .returning({ objectKey: profileCovers.objectKey });
      if (rows.length)
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
    return {
      profile: await getMyProfile(db, userId),
      changed: removed.length > 0,
    };
  });
}

/**
 * Records the chosen design or animation, with its colour and motion, already checked against
 * the catalogue by `coverDesignChoiceSchema`. An uploaded cover is left alone: it keeps winning
 * until it's removed, and then this choice shows. `design: null` with no animation clears the
 * choice; choosing an animation clears the design and the other way round, in one UPDATE.
 * Choosing what's already chosen writes nothing, and `changed` tells the caller there is nothing
 * to refresh.
 *
 * A Pro-only choice (`coverChoiceNeedsPro`) is refused for a page that is not Pro, checked
 * before the write and again in the UPDATE's WHERE, because staff may move the page to Free
 * between the two.
 */
export function setCoverDesign(
  db: Database,
  userId: string,
  choice: CoverDesignChoice,
): Promise<{ profile: MyProfile; changed: boolean }> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const animation = choice.animation ?? null;
    const design = animation ? null : choice.design;
    const colour = choice.colour ?? null;
    const motion = animation ? (choice.motion ?? null) : null;
    const needsPro = coverChoiceNeedsPro(choice);
    const isPro = async () => {
      const [row] = await db
        .select({ plan: profiles.plan })
        .from(profiles)
        .where(eq(profiles.id, profileId));
      return row?.plan === 'pro';
    };
    if (needsPro && !(await isPro()))
      throw new OperationError('COVER_DESIGN_PRO_REQUIRED');
    const updated = await db
      .update(profiles)
      .set({
        coverDesign: design,
        coverColour: colour,
        coverAnimation: animation,
        coverMotion: motion,
      })
      .where(
        and(
          eq(profiles.id, profileId),
          needsPro ? eq(profiles.plan, 'pro') : undefined,
          sql`(${profiles.coverDesign} IS DISTINCT FROM ${design} OR ${profiles.coverColour} IS DISTINCT FROM ${colour} OR ${profiles.coverAnimation} IS DISTINCT FROM ${animation} OR ${profiles.coverMotion} IS DISTINCT FROM ${motion})`,
        ),
      )
      .returning({ id: profiles.id });
    // Zero rows means unchanged, or the page lost Pro after the check: only the plan tells.
    if (updated.length === 0 && needsPro && !(await isPro()))
      throw new OperationError('COVER_DESIGN_PRO_REQUIRED');
    return {
      profile: await getMyProfile(db, userId),
      changed: updated.length > 0,
    };
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

/** The owner's own cover, for their preview: whatever the page's state. Never public. */
export function myCover(
  db: Database,
  userId: string,
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const [row] = await db
      .select({
        bytes: profileCovers.bytes,
        objectKey: profileCovers.objectKey,
      })
      .from(profileCovers)
      .where(eq(profileCovers.profileId, profileId));
    if (!row) return null;
    if (row.bytes) return row.bytes;
    return row.objectKey && store ? store.get(row.objectKey) : null;
  });
}
