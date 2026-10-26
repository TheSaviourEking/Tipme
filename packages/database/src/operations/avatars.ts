import { inspectAvatar } from '@tipme/domain';
import { and, eq, ne } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { avatars, profiles } from '../schema.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';

/** The public path a stored photo is served at by the web app. */
export const avatarPath = (id: string) => `/avatars/${id}.webp`;

async function replace(tx: Tx, profileId: string, next: string | null) {
  await tx.delete(avatars).where(eq(avatars.profileId, profileId));
  await tx
    .update(profiles)
    .set({ avatarPath: next })
    .where(eq(profiles.id, profileId));
}

async function ownPage(tx: Tx, userId: string) {
  const [page] = await tx
    .select({ id: profiles.id })
    .from(profiles)
    .where(and(eq(profiles.userId, userId), ne(profiles.pageState, 'deleted')));
  if (!page) throw new OperationError('NO_PAGE');
  return page.id;
}

/** The recipient sets their photo; anything but a plain, bounded WebP is refused. */
export function setMyAvatar(
  db: Database,
  input: { userId: string; bytes: Uint8Array },
): Promise<{ avatarPath: string }> {
  const photo = inspectAvatar(input.bytes);
  if (!photo) return Promise.reject(new OperationError('INVALID_INPUT'));
  return guarded(() =>
    db.transaction(async (tx) => {
      const profileId = await ownPage(tx, input.userId);
      const id = newId();
      const path = avatarPath(id);
      await replace(tx, profileId, path);
      await tx.insert(avatars).values({
        id,
        profileId,
        bytes: Buffer.from(photo.bytes),
        width: photo.width,
        height: photo.height,
      });
      return { avatarPath: path };
    }),
  );
}

/** The recipient removes their photo; the page falls back to their initials. */
export function removeMyAvatar(db: Database, userId: string): Promise<void> {
  return guarded(() =>
    db.transaction(async (tx) => {
      await replace(tx, await ownPage(tx, userId), null);
    }),
  );
}

/** Staff remove a page's photo with a reason (impersonation, abuse), audited. */
export function removeAvatarByStaff(
  db: Database,
  input: { profileId: string; staffUserId: string; reason: string },
): Promise<{ handle: string }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      const [page] = await tx
        .select({ id: profiles.id, handle: profiles.handle })
        .from(profiles)
        .where(eq(profiles.id, input.profileId));
      if (!page) throw new OperationError('PROFILE_NOT_FOUND');
      await replace(tx, input.profileId, null);
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'avatar.removed',
        permission: 'pages.suspend',
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: input.reason,
      });
      return { handle: page.handle };
    }),
  );
}

/** A stored photo's bytes by id, or null (unknown, removed, or a deleted page's). */
export function avatarBytes(db: Database, id: string): Promise<Buffer | null> {
  return guarded(async () => {
    const [row] = await db
      .select({ bytes: avatars.bytes })
      .from(avatars)
      .innerJoin(profiles, eq(profiles.id, avatars.profileId))
      .where(and(eq(avatars.id, id), ne(profiles.pageState, 'deleted')));
    return row?.bytes ?? null;
  });
}
