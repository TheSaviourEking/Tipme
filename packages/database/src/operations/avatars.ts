import type { MyProfile } from '@tipme/contracts';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { profileAvatars, profiles } from '../schema.js';
import { guarded, OperationError } from './errors.js';
import { getMyProfile } from './profiles.js';

// Profile photos (PR-013). The bytes stored here are always the server's own re-encoding
// (the API never stores an upload as sent); this module only keeps and serves them.

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
): Promise<MyProfile> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    await db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(profileAvatars)
        .values({ profileId, version: 1, bytes: webp })
        .onConflictDoUpdate({
          target: profileAvatars.profileId,
          set: {
            version: sql`${profileAvatars.version} + 1`,
            bytes: webp,
            createdAt: sql`now()`,
          },
        })
        .returning({ version: profileAvatars.version });
      await tx
        .update(profiles)
        .set({ avatarPath: avatarPathOf(profileId, saved!.version) })
        .where(eq(profiles.id, profileId));
    });
    return getMyProfile(db, userId);
  });
}

/** Removes the page's photo: its URL stops working at once. */
export function removeAvatar(db: Database, userId: string): Promise<MyProfile> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    await db.transaction(async (tx) => {
      await tx
        .delete(profileAvatars)
        .where(eq(profileAvatars.profileId, profileId));
      await tx
        .update(profiles)
        .set({ avatarPath: null })
        .where(eq(profiles.id, profileId));
    });
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
): Promise<Buffer | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ bytes: profileAvatars.bytes })
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
    return row?.bytes ?? null;
  });
}
