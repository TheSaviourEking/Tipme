import { randomUUID } from 'node:crypto';
import {
  COVER_RENDITION_WIDTHS,
  COVER_TALL_WIDTHS,
  coverChoiceNeedsPro,
  type CoverDesignChoice,
  type MyProfile,
} from '@tipme/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import { profileCoverRenditions, profileCovers, profiles } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import {
  deleteCoverRenditions,
  lockLivePage,
  myPageId,
  newRenditionSalt,
  removeObjects,
  renditionKeyOf,
  type CoverRenditionShape,
} from './page-images.js';

export type { CoverRenditionShape } from './page-images.js';
import { getMyProfile } from './profiles.js';

// Page covers. Stored and served exactly as page photos are (see avatars.ts): the bytes are
// always the server's own re-encoding, and an object is written before its row and removed after
// its row is gone.

export const coverPathOf = (profileId: string, version: number) =>
  `/v1/covers/${profileId}/${version}.webp`;

/**
 * A smaller copy of a cover, or its tall crop, already re-encoded on the server (apps/api
 * cover-renditions.ts). No `shape` means a wide copy.
 */
export interface CoverRenditionBytes {
  shape?: CoverRenditionShape;
  width: number;
  webp: Buffer;
}

const SHAPES: readonly CoverRenditionShape[] = ['wide', 'tall'];
const WIDTHS: Record<CoverRenditionShape, readonly number[]> = {
  wide: COVER_RENDITION_WIDTHS,
  tall: COVER_TALL_WIDTHS,
};
const isRendition = (shape: string, width: number) =>
  (SHAPES as readonly string[]).includes(shape) &&
  WIDTHS[shape as CoverRenditionShape].includes(width);
const shapeOf = (r: CoverRenditionBytes): CoverRenditionShape =>
  r.shape ?? 'wide';
const checkRenditions = (renditions: CoverRenditionBytes[]) => {
  if (renditions.some((r) => !isRendition(shapeOf(r), r.width)))
    throw new Error('not a cover rendition width');
};

/**
 * Replaces the page's cover with already re-encoded WebP bytes; a new version, a new URL. Its
 * renditions are kept where the cover is, under the same version; the last cover's go with it.
 */
export function setCover(
  db: Database,
  userId: string,
  webp: Buffer,
  store?: PhotoStore,
  renditions: CoverRenditionBytes[] = [],
): Promise<MyProfile> {
  return guarded(async () => {
    checkRenditions(renditions);
    const profileId = await myPageId(db, userId);
    // Uploaded first: if this fails, nothing in the database changed.
    const objectKey = store ? `covers/${profileId}/${randomUUID()}.webp` : null;
    const salt = newRenditionSalt();
    const sized = renditions.map((r) => ({
      ...r,
      shape: shapeOf(r),
      objectKey: objectKey
        ? renditionKeyOf(objectKey, r.width, salt, shapeOf(r))
        : null,
    }));
    const written: string[] = [];
    let previous: string[] = [];
    try {
      if (store && objectKey) {
        await store.put(objectKey, webp);
        written.push(objectKey);
        for (const r of sized) {
          await store.put(r.objectKey!, r.webp);
          written.push(r.objectKey!);
        }
      }
      await db.transaction(async (tx) => {
        await lockLivePage(tx, profileId);
        const [old] = await tx
          .select({ objectKey: profileCovers.objectKey })
          .from(profileCovers)
          .where(eq(profileCovers.profileId, profileId))
          .for('update');
        previous = [
          ...(old?.objectKey ? [old.objectKey] : []),
          ...(await deleteCoverRenditions(tx, profileId)),
        ];
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
        if (sized.length)
          await tx.insert(profileCoverRenditions).values(
            sized.map((r) => ({
              profileId,
              version,
              shape: r.shape,
              width: r.width,
              ...(r.objectKey
                ? { bytes: null, objectKey: r.objectKey }
                : { bytes: r.webp, objectKey: null }),
            })),
          );
        await tx
          .update(profiles)
          .set({ coverPath: coverPathOf(profileId, version) })
          .where(eq(profiles.id, profileId));
      });
    } catch (error) {
      await removeObjects(store, written);
      throw error;
    }
    await removeObjects(store, previous);
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
    const renditionKeys: string[] = [];
    const removed = await db.transaction(async (tx) => {
      await lockLivePage(tx, profileId);
      renditionKeys.push(...(await deleteCoverRenditions(tx, profileId)));
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
    await removeObjects(store, [
      ...removed.flatMap((r) => (r.objectKey ? [r.objectKey] : [])),
      ...renditionKeys,
    ]);
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

/**
 * A cover's rendition or tall crop to serve, under exactly the cover's rules (`coverFor`): the
 * current version only, only while the page is live and not paused. Null for a width that was
 * never stored. No `shape` means a wide copy.
 */
export function coverRenditionFor(
  db: Database,
  input: {
    profileId: string;
    version: number;
    shape?: CoverRenditionShape;
    width: number;
  },
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    const shape = input.shape ?? 'wide';
    if (!isRendition(shape, input.width)) return null;
    const [row] = await db
      .select({
        bytes: profileCoverRenditions.bytes,
        objectKey: profileCoverRenditions.objectKey,
      })
      .from(profileCoverRenditions)
      .innerJoin(
        profileCovers,
        and(
          eq(profileCovers.profileId, profileCoverRenditions.profileId),
          eq(profileCovers.version, profileCoverRenditions.version),
        ),
      )
      .innerJoin(profiles, eq(profiles.id, profileCoverRenditions.profileId))
      .where(
        and(
          eq(profileCoverRenditions.profileId, input.profileId),
          eq(profileCoverRenditions.version, input.version),
          eq(profileCoverRenditions.shape, shape),
          eq(profileCoverRenditions.width, input.width),
          eq(profiles.pageState, 'live'),
          eq(profiles.status, 'active'),
        ),
      );
    if (!row) return null;
    if (row.bytes) return row.bytes;
    return row.objectKey && store ? store.get(row.objectKey) : null;
  });
}

// The backfill (apps/api/src/scripts/backfill-cover-renditions.ts): covers uploaded before
// renditions existed get them, once, whatever the page's state (a paused page may come back).

/**
 * Covers missing a shape of rendition (the wide copies, the tall crop, or both) for their current
 * version, oldest first, with the shapes they lack: the backfill's work list.
 */
export function coversWithoutRenditions(db: Database): Promise<
  {
    profileId: string;
    version: number;
    inStore: boolean;
    missing: CoverRenditionShape[];
  }[]
> {
  return guarded(async () => {
    // Rows for another version don't count (an older API replaced the cover during a blue/green
    // overlap, not knowing about renditions): that cover still needs its own.
    // Names written out: drizzle leaves columns unqualified in a select list, and there the inner
    // and outer `profile_id` would be the same column.
    const has = (shape: CoverRenditionShape) =>
      sql<boolean>`EXISTS (SELECT 1 FROM profile_cover_renditions r
        WHERE r.profile_id = profile_covers.profile_id
          AND r.version = profile_covers.version
          AND r.shape = ${shape})`;
    const rows = await db
      .select({
        profileId: profileCovers.profileId,
        version: profileCovers.version,
        objectKey: profileCovers.objectKey,
        wide: has('wide'),
        tall: has('tall'),
      })
      .from(profileCovers)
      .where(sql`NOT (${has('wide')} AND ${has('tall')})`)
      .orderBy(profileCovers.createdAt);
    return rows.map((r) => ({
      profileId: r.profileId,
      version: r.version,
      inStore: r.objectKey !== null,
      missing: SHAPES.filter((shape) => !r[shape]),
    }));
  });
}

/** A cover's stored bytes at this version, whatever the page's state; never served from here. */
export function storedCover(
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
      .where(
        and(
          eq(profileCovers.profileId, input.profileId),
          eq(profileCovers.version, input.version),
        ),
      );
    if (!row) return null;
    if (row.bytes) return row.bytes;
    return row.objectKey && store ? store.get(row.objectKey) : null;
  });
}

/**
 * Adds renditions to a cover, where the cover is kept (the store when it is there), for each shape
 * (wide copies, tall crop) it has none of at its version, and drops any rows left from another
 * version (their objects are removed after the commit). A shape the cover already has is never
 * touched, and the given renditions of that shape are dropped. Writes nothing, and returns false,
 * when the cover was replaced or removed meanwhile or already has every shape given: so running
 * twice, or beside an upload, is safe.
 *
 * Locks the page first, as `setCover` and every removal path do (removeCover, the staff removal,
 * account deletion): they delete the renditions and then the cover under that lock, and a write
 * landing in between would have its rows cascade away and its objects stay in the bucket unseen.
 * A deleted page is refused by the same lock.
 */
export function addCoverRenditions(
  db: Database,
  input: {
    profileId: string;
    version: number;
    renditions: CoverRenditionBytes[];
  },
  store?: PhotoStore,
  /** Called with each object key before it is written, so a run killed mid-cover can be traced. */
  beforePut: (objectKey: string) => void = () => {},
): Promise<boolean> {
  return guarded(async () => {
    checkRenditions(input.renditions);
    if (!input.renditions.length) return false;
    const [cover] = await db
      .select({ objectKey: profileCovers.objectKey })
      .from(profileCovers)
      .where(
        and(
          eq(profileCovers.profileId, input.profileId),
          eq(profileCovers.version, input.version),
        ),
      );
    if (!cover) return false;
    if (cover.objectKey && !store)
      throw new Error('this cover is in the object store: pass the store');
    const salt = newRenditionSalt();
    const sized = input.renditions.map((r) => ({
      ...r,
      shape: shapeOf(r),
      objectKey: cover.objectKey
        ? renditionKeyOf(cover.objectKey, r.width, salt, shapeOf(r))
        : null,
    }));
    /** The objects written for renditions that were then inserted: every other one is removed. */
    const kept = new Set<string>();
    const written: string[] = [];
    try {
      for (const r of sized)
        if (r.objectKey && store) {
          beforePut(r.objectKey);
          await store.put(r.objectKey, r.webp);
          written.push(r.objectKey);
        }
      const stale: string[] = [];
      const added = await db.transaction(async (tx) => {
        try {
          await lockLivePage(tx, input.profileId);
        } catch (error) {
          if (error instanceof OperationError) return false;
          throw error;
        }
        const [still] = await tx
          .select({ objectKey: profileCovers.objectKey })
          .from(profileCovers)
          .where(
            and(
              eq(profileCovers.profileId, input.profileId),
              eq(profileCovers.version, input.version),
            ),
          )
          .for('update');
        // Replaced, or moved to the store, since it was read: the next run starts again.
        if (!still || still.objectKey !== cover.objectKey) return false;
        const others = await tx
          .delete(profileCoverRenditions)
          .where(
            and(
              eq(profileCoverRenditions.profileId, input.profileId),
              ne(profileCoverRenditions.version, input.version),
            ),
          )
          .returning({ objectKey: profileCoverRenditions.objectKey });
        stale.push(
          ...others.flatMap((r) => (r.objectKey ? [r.objectKey] : [])),
        );
        // Only rows of this version are left, so a shape present here is the cover's own.
        const present = new Set(
          (
            await tx
              .select({ shape: profileCoverRenditions.shape })
              .from(profileCoverRenditions)
              .where(eq(profileCoverRenditions.profileId, input.profileId))
          ).map((r) => r.shape),
        );
        const adding = sized.filter((r) => !present.has(r.shape));
        if (!adding.length) return false;
        await tx.insert(profileCoverRenditions).values(
          adding.map((r) => ({
            profileId: input.profileId,
            version: input.version,
            shape: r.shape,
            width: r.width,
            ...(r.objectKey
              ? { bytes: null, objectKey: r.objectKey }
              : { bytes: r.webp, objectKey: null }),
          })),
        );
        for (const r of adding) if (r.objectKey) kept.add(r.objectKey);
        return true;
      });
      await removeObjects(store, stale);
      await removeObjects(
        store,
        written.filter((key) => !kept.has(key)),
      );
      return added;
    } catch (error) {
      await removeObjects(store, written);
      throw error;
    }
  });
}
