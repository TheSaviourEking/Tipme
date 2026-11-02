import type { OpsPageImage } from '@tipme/contracts';
import { and, eq, ne } from 'drizzle-orm';
import type { Database } from '../client.js';
import { newId } from './ids.js';
import type { PhotoStore } from '../photo-store.js';
import { profileAvatars, profileCovers, profiles } from '../schema.js';
import { mailOwner } from './account-mail.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import type { MailSealing } from './mail-queue.js';
import { removeObjects } from './page-images.js';

// Staff review a page's cover or photo and remove either alone (permission `pages.suspend`):
// pausing the page is the only other tool, and it stops the person's tips too.

const tableOf = (image: OpsPageImage) =>
  image === 'cover' ? profileCovers : profileAvatars;

/** An image as staff see it, whatever the page's state; audited. Null when there is none. */
export function staffViewPageImage(
  db: Database,
  input: { staffUserId: string; profileId: string; image: OpsPageImage },
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    const table = tableOf(input.image);
    const [row] = await db
      .select({ bytes: table.bytes, objectKey: table.objectKey })
      .from(table)
      .innerJoin(profiles, eq(profiles.id, table.profileId))
      .where(
        and(
          eq(table.profileId, input.profileId),
          ne(profiles.pageState, 'deleted'),
        ),
      );
    if (!row) return null;
    const bytes =
      row.bytes ??
      (row.objectKey && store ? await store.get(row.objectKey) : null);
    if (!bytes) return null;
    await recordAudit(db, {
      staffUserId: input.staffUserId,
      action: `page.${input.image}_viewed`,
      permission: 'pages.suspend',
      subjectType: 'profile',
      subjectId: input.profileId,
    });
    return bytes;
  });
}

/**
 * Removes one image for good: the row and path go, and the version counter stays, so restoring
 * the page or a new upload can never bring this URL back. Audited with the reason; the owner is
 * told what happened, not why. Removing what's already gone records and sends nothing.
 */
export function staffRemovePageImage(
  db: Database,
  input: {
    staffUserId: string;
    profileId: string;
    image: OpsPageImage;
    reason: string;
    sealing: MailSealing;
    store?: PhotoStore | undefined;
  },
): Promise<{ handle: string; changed: boolean }> {
  return guarded(async () => {
    const table = tableOf(input.image);
    const { handle, keys, changed } = await db.transaction(async (tx) => {
      const [page] = await tx
        .select({
          handle: profiles.handleLower,
          avatarPath: profiles.avatarPath,
          coverPath: profiles.coverPath,
        })
        .from(profiles)
        .where(
          and(
            eq(profiles.id, input.profileId),
            ne(profiles.pageState, 'deleted'),
          ),
        )
        .for('update');
      if (!page) throw new OperationError('PROFILE_NOT_FOUND');
      const had = input.image === 'cover' ? page.coverPath : page.avatarPath;
      if (!had) return { handle: page.handle, keys: [], changed: false };
      const removed = await tx
        .delete(table)
        .where(eq(table.profileId, input.profileId))
        .returning({ objectKey: table.objectKey });
      await tx
        .update(profiles)
        .set(
          input.image === 'cover' ? { coverPath: null } : { avatarPath: null },
        )
        .where(eq(profiles.id, input.profileId));
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: `page.${input.image}_removed`,
        permission: 'pages.suspend',
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: input.reason,
      });
      await mailOwner(tx, input.sealing, {
        profileId: input.profileId,
        type: 'page_image_removed',
        data: { image: input.image },
        // Each removal is news: the owner may upload again and have that removed too.
        dedupeKey: `page_image_removed.${input.profileId}.${newId()}`,
      });
      return {
        handle: page.handle,
        keys: removed.flatMap((r) => (r.objectKey ? [r.objectKey] : [])),
        changed: true,
      };
    });
    await removeObjects(input.store, keys);
    return { handle, changed };
  });
}
