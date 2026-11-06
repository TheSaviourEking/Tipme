import { randomUUID } from 'node:crypto';
import type { BusinessDetail } from '@tipme/contracts';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import { businesses, businessLogos } from '../schema.js';
import { recordAudit } from './audit.js';
import { managerOf } from './business-access.js';
import { businessDetail } from './business-manage.js';
import { guarded, OperationError } from './errors.js';
import { removeObjects } from './page-images.js';

// A business's logo (6 Nov 2026): the page-photo pipeline, for a business. The API re-encodes every
// upload to a 512×512 WebP without metadata (image-upload.ts) before it reaches this module; here it
// is kept in Postgres or in R2 exactly like `profile_avatars` (avatars.ts says why the object is
// written before its row and removed after it). Owners only, and every change is in the audit log.

export const logoPathOf = (businessId: string, version: number) =>
  `/v1/business-logos/${businessId}/${version}.webp`;

/** Locks the business for the rest of the transaction, so two uploads take turns. */
async function lockBusiness(tx: Tx, businessId: string) {
  const [row] = await tx
    .select({ id: businesses.id })
    .from(businesses)
    .where(eq(businesses.id, businessId))
    .for('update');
  if (!row) throw new OperationError('NOT_A_MANAGER');
}

/** Owners only (a location manager is OWNER_REQUIRED). A new version, so a new URL. */
export function setBusinessLogo(
  db: Database,
  userId: string,
  businessId: string,
  webp: Buffer,
  store?: PhotoStore,
  now: Date = new Date(),
): Promise<{ slug: string; detail: BusinessDetail }> {
  return guarded(async () => {
    // Asked before anything is uploaded: a stranger's bytes never reach the bucket.
    await managerOf(db, userId, businessId, { owner: true });
    const objectKey = store ? `logos/${businessId}/${randomUUID()}.webp` : null;
    if (store && objectKey) await store.put(objectKey, webp);
    let previous: string | null = null;
    let slug = '';
    try {
      await db.transaction(async (tx) => {
        await lockBusiness(tx, businessId);
        // Again under the lock: an owner removed meanwhile can't still set it.
        await managerOf(tx, userId, businessId, { owner: true });
        const [old] = await tx
          .select({ objectKey: businessLogos.objectKey })
          .from(businessLogos)
          .where(eq(businessLogos.businessId, businessId))
          .for('update');
        previous = old?.objectKey ?? null;
        const [next] = await tx
          .update(businesses)
          .set({ logoVersion: sql`${businesses.logoVersion} + 1` })
          .where(eq(businesses.id, businessId))
          .returning({ version: businesses.logoVersion });
        const version = next!.version;
        const stored = objectKey
          ? { bytes: null, objectKey }
          : { bytes: webp, objectKey: null };
        await tx
          .insert(businessLogos)
          .values({ businessId, version, ...stored })
          .onConflictDoUpdate({
            target: businessLogos.businessId,
            set: { version, ...stored, createdAt: sql`now()` },
          });
        const [row] = await tx
          .update(businesses)
          .set({ logoPath: logoPathOf(businessId, version) })
          .where(eq(businesses.id, businessId))
          .returning({ slug: businesses.slug });
        slug = row!.slug;
        await recordAudit(tx, {
          staffUserId: userId,
          action: 'business.logo_set',
          subjectType: 'business',
          subjectId: businessId,
          now,
        });
      });
    } catch (error) {
      if (objectKey) await removeObjects(store, [objectKey]);
      throw error;
    }
    if (previous) await removeObjects(store, [previous]);
    return { slug, detail: await businessDetail(db, userId, businessId) };
  });
}

/** Owners only. The tile shows the initial again, and the old URL stops working at once. */
export function removeBusinessLogo(
  db: Database,
  userId: string,
  businessId: string,
  store?: PhotoStore,
  now: Date = new Date(),
): Promise<{ slug: string; detail: BusinessDetail }> {
  return guarded(async () => {
    const { removed, slug } = await db.transaction(async (tx) => {
      await managerOf(tx, userId, businessId, { owner: true });
      await lockBusiness(tx, businessId);
      const rows = await tx
        .delete(businessLogos)
        .where(eq(businessLogos.businessId, businessId))
        .returning({ objectKey: businessLogos.objectKey });
      const [row] = await tx
        .update(businesses)
        .set({ logoPath: null })
        .where(eq(businesses.id, businessId))
        .returning({ slug: businesses.slug });
      // Removing nothing changes nothing, and isn't worth an audit row.
      if (rows.length)
        await recordAudit(tx, {
          staffUserId: userId,
          action: 'business.logo_removed',
          subjectType: 'business',
          subjectId: businessId,
          now,
        });
      return { removed: rows, slug: row!.slug };
    });
    await removeObjects(
      store,
      removed.flatMap((r) => (r.objectKey ? [r.objectKey] : [])),
    );
    return { slug, detail: await businessDetail(db, userId, businessId) };
  });
}

async function logoBytes(
  db: Database,
  where: SQL | undefined,
  store?: PhotoStore,
): Promise<Buffer | null> {
  const [row] = await db
    .select({ bytes: businessLogos.bytes, objectKey: businessLogos.objectKey })
    .from(businessLogos)
    .innerJoin(businesses, eq(businesses.id, businessLogos.businessId))
    .where(where);
  if (!row) return null;
  if (row.bytes) return row.bytes;
  return row.objectKey && store ? store.get(row.objectKey) : null;
}

/**
 * The public logo: only the current version, and only while the business is verified (a waiting or
 * paused business has no public pages, so its logo is as unavailable as they are).
 */
export function businessLogoFor(
  db: Database,
  input: { businessId: string; version: number },
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(() =>
    logoBytes(
      db,
      and(
        eq(businessLogos.businessId, input.businessId),
        eq(businessLogos.version, input.version),
        eq(businesses.status, 'verified'),
      ),
      store,
    ),
  );
}

/** Any manager of the business, whatever its status: the dashboard shows it before verification. */
export function managedBusinessLogo(
  db: Database,
  userId: string,
  businessId: string,
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    await managerOf(db, userId, businessId);
    return logoBytes(db, eq(businessLogos.businessId, businessId), store);
  });
}

/** TipMe staff, whatever the business's status (the ops business page). Null without one. */
export function staffBusinessLogo(
  db: Database,
  businessId: string,
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(() =>
    logoBytes(db, eq(businessLogos.businessId, businessId), store),
  );
}
