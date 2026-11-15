import { randomUUID } from 'node:crypto';
import {
  DESIGN_CHECK_VERSION,
  STUDIO_LIMITS,
  checkDesign,
  defaultStudioDocument,
  deriveStudioPalette,
  resolveStudio,
  studioDocumentSchema,
  visibleLinks,
  type MyStudio,
  type PagePlan,
  type PublicStudio,
  type SocialLink,
  type StudioBlock,
  type StudioCheckContext,
  type StudioDocument,
  type StudioIssue,
} from '@tipme/contracts';
import { and, eq, gt, inArray, ne, notInArray, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import {
  pageStudios,
  profiles,
  studioImageFiles,
  studioImages,
  studioVideoChecks,
} from '../schema.js';
import { mailOwner } from './account-mail.js';
import { recordAudit } from './audit.js';
import { guarded, OperationError } from './errors.js';
import { newId } from './ids.js';
import type { MailSealing } from './mail-queue.js';
import { lockLivePage, myPageId, removeObjects } from './page-images.js';

// Page Studio storage (plan 2026-11-12-page-studio, Task 7). A Pro page keeps a draft and a
// published version; saving never needs a passing design check, publishing always does, with the
// server's own facts (photo sizes, video status, the page's bio and links). Photos are stored as
// covers are: re-encoded on the server, each file in Postgres or in R2, objects written before
// their rows and removed after the change commits. Free pages get an in-memory preview, never
// stored; a lapsed Pro page keeps everything, read-only, and shows the standard page.

type Db = Database | Tx;

/** Today in Lagos, YYYY-MM-DD: events before it are hidden. */
export const lagosToday = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(now);

const ownerPath = (imageId: string, version: number) =>
  `/v1/me/studio-images/${imageId}/${version}`;
export const studioImagePathOf = (
  profileId: string,
  imageId: string,
  version: number,
) => `/v1/studio-images/${profileId}/${imageId}/${version}`;

/** Every image id a document uses: photos, gallery photos and photo row backgrounds. */
export function studioImageIds(doc: StudioDocument): Set<string> {
  const ids = new Set<string>();
  for (const row of doc.rows) {
    if (typeof row.background === 'object') ids.add(row.background.photo);
    for (const cell of row.cells)
      for (const b of cell) {
        if (b.kind === 'photo') ids.add(b.imageId);
        if (b.kind === 'gallery') for (const i of b.images) ids.add(i.imageId);
      }
  }
  return ids;
}

/** Every video link a document uses, for the server's video check. */
export function studioVideoUrls(doc: StudioDocument): string[] {
  return [
    ...new Set(
      doc.rows.flatMap((row) =>
        row.cells.flat().flatMap((b) => (b.kind === 'video' ? [b.url] : [])),
      ),
    ),
  ];
}

/** The document without one photo: its blocks go, a gallery left empty goes, a row's photo goes. */
export function withoutStudioImage(
  doc: StudioDocument,
  imageId: string,
): StudioDocument {
  return {
    ...doc,
    rows: doc.rows.map((row) => ({
      ...row,
      background:
        typeof row.background === 'object' && row.background.photo === imageId
          ? 'page'
          : row.background,
      cells: row.cells.map((cell) =>
        cell.flatMap((b): StudioBlock[] => {
          if (b.kind === 'photo' && b.imageId === imageId) return [];
          if (b.kind !== 'gallery') return [b];
          const images = b.images.filter((i) => i.imageId !== imageId);
          if (images.length === b.images.length) return [b];
          return images.length ? [{ ...b, images }] : [];
        }),
      ),
    })),
  };
}

interface PageFacts {
  id: string;
  handle: string;
  plan: PagePlan;
  bio: string | null;
  links: SocialLink[];
}

async function pageFacts(db: Db, profileId: string): Promise<PageFacts> {
  const [row] = await db
    .select({
      id: profiles.id,
      handleLower: profiles.handleLower,
      plan: profiles.plan,
      bio: profiles.bio,
      bioPublic: profiles.bioPublic,
      links: profiles.links,
      socialsPublic: profiles.socialsPublic,
    })
    .from(profiles)
    .where(eq(profiles.id, profileId));
  if (!row) throw new OperationError('NO_PAGE');
  return studioPageFacts(row);
}

const linkCount = (page: PageFacts) =>
  visibleLinks(page.links, page.plan, { adult: true }).length;

interface ImageFacts {
  id: string;
  version: number;
  width: number;
  height: number;
  focalX: number;
  focalY: number;
  bytes: Record<string, number>;
}

async function imagesOf(db: Db, profileId: string): Promise<ImageFacts[]> {
  const rows = await db
    .select()
    .from(studioImages)
    .where(eq(studioImages.profileId, profileId))
    .orderBy(studioImages.createdAt, studioImages.id);
  if (rows.length === 0) return [];
  const files = await db
    .select({
      imageId: studioImageFiles.imageId,
      name: studioImageFiles.name,
      size: studioImageFiles.size,
    })
    .from(studioImageFiles)
    .where(
      inArray(
        studioImageFiles.imageId,
        rows.map((r) => r.id),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    width: r.width,
    height: r.height,
    focalX: r.focalX,
    focalY: r.focalY,
    bytes: Object.fromEntries(
      files
        .filter((f) => f.imageId === r.id && f.name !== 'master')
        .map((f) => [f.name, f.size]),
    ),
  }));
}

const VIDEO_FRESH_MS = 24 * 3_600_000;

/** What the video sites said in the last day, for these links. */
export function studioVideoChecksFor(
  db: Db,
  urls: string[],
): Promise<Record<string, 'ok' | 'gone' | 'unknown'>> {
  return guarded(async () => {
    if (urls.length === 0) return {};
    const rows = await db
      .select({ url: studioVideoChecks.url, status: studioVideoChecks.status })
      .from(studioVideoChecks)
      .where(
        and(
          inArray(studioVideoChecks.url, urls),
          gt(
            studioVideoChecks.checkedAt,
            new Date(Date.now() - VIDEO_FRESH_MS),
          ),
        ),
      );
    return Object.fromEntries(
      rows.map((r) => [r.url, r.status as 'ok' | 'gone' | 'unknown']),
    );
  });
}

/** Keeps what the video sites just said, for a day. */
export function recordStudioVideoChecks(
  db: Db,
  results: Record<string, 'ok' | 'gone' | 'unknown'>,
): Promise<void> {
  return guarded(async () => {
    const now = new Date();
    for (const [url, status] of Object.entries(results))
      await db
        .insert(studioVideoChecks)
        .values({ url, status, checkedAt: now })
        .onConflictDoUpdate({
          target: studioVideoChecks.url,
          set: { status, checkedAt: now },
        });
  });
}

async function contextFor(
  db: Db,
  page: PageFacts,
  doc: StudioDocument,
  images?: ImageFacts[],
): Promise<StudioCheckContext> {
  const all = images ?? (await imagesOf(db, page.id));
  const videos = await studioVideoChecksFor(db, studioVideoUrls(doc));
  return {
    images: Object.fromEntries(
      all.map((i) => [
        i.id,
        { width: i.width, height: i.height, bytes: i.bytes },
      ]),
    ),
    videos,
    profile: { bio: Boolean(page.bio), links: linkCount(page) },
  };
}

async function myStudioOf(db: Db, profileId: string): Promise<MyStudio> {
  const page = await pageFacts(db, profileId);
  const [row] = await db
    .select()
    .from(pageStudios)
    .where(eq(pageStudios.profileId, profileId));
  const today = lagosToday();
  const draft = row
    ? resolveStudio(row.draft, today)
    : defaultStudioDocument({ bio: page.bio, links: linkCount(page) });
  const images = await imagesOf(db, profileId);
  const context = await contextFor(db, page, draft, images);
  return {
    draft,
    published: row?.published ? resolveStudio(row.published, today) : null,
    rev: row?.rev ?? 0,
    publishedAt: row?.publishedAt?.toISOString() ?? null,
    check: checkDesign(draft, context),
    context,
    images: images.map((i) => ({
      imageId: i.id,
      path: ownerPath(i.id, i.version),
      width: i.width,
      height: i.height,
      focalX: i.focalX,
      focalY: i.focalY,
    })),
    access: page.plan === 'pro' ? 'edit' : row ? 'lapsed' : 'preview',
  };
}

/** The owner's Studio: the draft, the published version, the check and the photos. */
export function getMyStudio(db: Database, userId: string): Promise<MyStudio> {
  return guarded(async () => myStudioOf(db, await myPageId(db, userId)));
}

/** Locks the page and refuses a page that isn't Pro (now, under the lock). */
async function lockProPage(tx: Tx, profileId: string) {
  await lockLivePage(tx, profileId);
  const page = await pageFacts(tx, profileId);
  if (page.plan !== 'pro') throw new OperationError('STUDIO_PRO_REQUIRED');
  return page;
}

/**
 * Deletes the page's photos that neither the draft nor the published version uses, returning
 * their object keys to remove after the change commits.
 */
async function dropUnused(
  tx: Tx,
  profileId: string,
  keep: Set<string>,
): Promise<string[]> {
  const unused = await tx
    .select({ id: studioImages.id })
    .from(studioImages)
    .where(
      and(
        eq(studioImages.profileId, profileId),
        keep.size ? notInArray(studioImages.id, [...keep]) : undefined,
      ),
    );
  if (unused.length === 0) return [];
  const ids = unused.map((u) => u.id);
  const keys = await tx
    .select({ key: studioImageFiles.objectKey })
    .from(studioImageFiles)
    .where(inArray(studioImageFiles.imageId, ids));
  await tx.delete(studioImages).where(inArray(studioImages.id, ids));
  return keys.flatMap((k) => (k.key ? [k.key] : []));
}

/**
 * Saves the draft (already accepted by `studioDocumentSchema`) if it was based on the latest
 * revision; STUDIO_DRAFT_STALE otherwise, keeping the newer one. Photos must be this page's own.
 */
export function saveStudioDraft(
  db: Database,
  userId: string,
  input: { rev: number; draft: StudioDocument },
): Promise<MyStudio> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    // The API's pipe checked it; checked again here, as nothing else may reach the column.
    if (!studioDocumentSchema.safeParse(input.draft).success)
      throw new OperationError('STUDIO_DRAFT_INVALID');
    await db.transaction(async (tx) => {
      await lockProPage(tx, profileId);
      const used = [...studioImageIds(input.draft)];
      if (used.length) {
        const owned = await tx
          .select({ id: studioImages.id })
          .from(studioImages)
          .where(
            and(
              eq(studioImages.profileId, profileId),
              inArray(studioImages.id, used),
            ),
          );
        if (owned.length !== used.length)
          throw new OperationError('STUDIO_DRAFT_INVALID');
      }
      const [row] = await tx
        .select({ rev: pageStudios.rev })
        .from(pageStudios)
        .where(eq(pageStudios.profileId, profileId))
        .for('update');
      if ((row?.rev ?? 0) !== input.rev)
        throw new OperationError('STUDIO_DRAFT_STALE');
      if (!row)
        await tx
          .insert(pageStudios)
          .values({ profileId, draft: input.draft, rev: 1 });
      else
        await tx
          .update(pageStudios)
          .set({
            draft: input.draft,
            rev: sql`${pageStudios.rev} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(pageStudios.profileId, profileId));
    });
    return myStudioOf(db, profileId);
  });
}

export type PublishResult =
  | { published: true; studio: MyStudio; handle: string }
  | { published: false; studio: MyStudio; issues: StudioIssue[] };

/**
 * Publishes the draft when the design check passes with the server's facts; otherwise nothing
 * changes and the issues come back (there is no "publish anyway", owner ruling 12). Photos used by
 * neither version are deleted.
 */
export function publishStudio(
  db: Database,
  userId: string,
  input: { rev: number },
  store?: PhotoStore,
): Promise<PublishResult> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const outcome = await db.transaction(async (tx) => {
      const page = await lockProPage(tx, profileId);
      const [row] = await tx
        .select()
        .from(pageStudios)
        .where(eq(pageStudios.profileId, profileId))
        .for('update');
      if (!row || row.rev !== input.rev)
        throw new OperationError('STUDIO_DRAFT_STALE');
      const draft = resolveStudio(row.draft, lagosToday());
      const { issues } = checkDesign(draft, await contextFor(tx, page, draft));
      if (issues.length) return { issues, keys: [] as string[] };
      await tx
        .update(pageStudios)
        .set({
          published: draft,
          publishedCheckVersion: DESIGN_CHECK_VERSION,
          publishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(pageStudios.profileId, profileId));
      const keys = await dropUnused(tx, profileId, studioImageIds(draft));
      return { issues: [] as StudioIssue[], keys, handle: page.handle };
    });
    await removeObjects(store, outcome.keys);
    const studio = await myStudioOf(db, profileId);
    return outcome.issues.length || !('handle' in outcome)
      ? { published: false, studio, issues: outcome.issues }
      : { published: true, studio, handle: outcome.handle! };
  });
}

/**
 * Throws the draft away: back to the published version, or to nothing when there isn't one. The
 * photos only the draft used go with it.
 */
export function discardStudioDraft(
  db: Database,
  userId: string,
  store?: PhotoStore,
): Promise<MyStudio> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const keys = await db.transaction(async (tx) => {
      await lockProPage(tx, profileId);
      const [row] = await tx
        .select()
        .from(pageStudios)
        .where(eq(pageStudios.profileId, profileId))
        .for('update');
      if (!row) return dropUnused(tx, profileId, new Set());
      if (!row.published) {
        await tx
          .delete(pageStudios)
          .where(eq(pageStudios.profileId, profileId));
        return dropUnused(tx, profileId, new Set());
      }
      await tx
        .update(pageStudios)
        .set({
          draft: row.published,
          rev: sql`${pageStudios.rev} + 1`,
          updatedAt: sql`now()`,
        })
        .where(eq(pageStudios.profileId, profileId));
      return dropUnused(
        tx,
        profileId,
        studioImageIds(resolveStudio(row.published, lagosToday())),
      );
    });
    await removeObjects(store, keys);
    return myStudioOf(db, profileId);
  });
}

/** Files already re-encoded by the API: the master and its crops, named `master`, `square-960`… */
export type StudioImageFiles = Record<string, Buffer>;

async function putFiles(
  store: PhotoStore | undefined,
  imageId: string,
  profileId: string,
  files: StudioImageFiles,
) {
  const rows: {
    imageId: string;
    name: string;
    size: number;
    bytes: Buffer | null;
    objectKey: string | null;
  }[] = [];
  for (const [name, webp] of Object.entries(files)) {
    const objectKey = store ? `studio/${profileId}/${randomUUID()}.webp` : null;
    if (store && objectKey) await store.put(objectKey, webp);
    rows.push({
      imageId,
      name,
      size: webp.length,
      bytes: objectKey ? null : webp,
      objectKey,
    });
  }
  return rows;
}

/** Adds a photo (master and crops, focal point in the middle); STUDIO_IMAGE_LIMIT past 48. */
export function addStudioImage(
  db: Database,
  userId: string,
  input: { width: number; height: number; files: StudioImageFiles },
  store?: PhotoStore,
): Promise<{ studio: MyStudio; imageId: string }> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const imageId = randomUUID();
    // Uploaded first: if this fails, nothing in the database changed.
    const rows = await putFiles(store, imageId, profileId, input.files);
    try {
      await db.transaction(async (tx) => {
        await lockProPage(tx, profileId);
        const [{ count } = { count: 0 }] = await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(studioImages)
          .where(eq(studioImages.profileId, profileId));
        if (count >= STUDIO_LIMITS.storedImages)
          throw new OperationError('STUDIO_IMAGE_LIMIT');
        await tx.insert(studioImages).values({
          id: imageId,
          profileId,
          width: input.width,
          height: input.height,
        });
        await tx.insert(studioImageFiles).values(rows);
      });
    } catch (error) {
      await removeObjects(
        store,
        rows.flatMap((r) => (r.objectKey ? [r.objectKey] : [])),
      );
      throw error;
    }
    return { studio: await myStudioOf(db, profileId), imageId };
  });
}

async function fileBytes(
  db: Db,
  imageId: string,
  name: string,
  store?: PhotoStore,
): Promise<Buffer | null> {
  const [file] = await db
    .select({
      bytes: studioImageFiles.bytes,
      objectKey: studioImageFiles.objectKey,
    })
    .from(studioImageFiles)
    .where(
      and(
        eq(studioImageFiles.imageId, imageId),
        eq(studioImageFiles.name, name),
      ),
    );
  if (!file) return null;
  if (file.bytes) return file.bytes;
  return file.objectKey && store ? store.get(file.objectKey) : null;
}

/** The owner's master of one photo, to cut new crops from; null when it isn't theirs. */
export function studioImageMaster(
  db: Database,
  userId: string,
  imageId: string,
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const [image] = await db
      .select({ id: studioImages.id })
      .from(studioImages)
      .where(
        and(
          eq(studioImages.id, imageId),
          eq(studioImages.profileId, profileId),
        ),
      );
    return image ? fileBytes(db, imageId, 'master', store) : null;
  });
}

/**
 * A new focal point and the crops cut around it: a new version, so the photo gets a new address
 * and no cache shows the old crop.
 */
export function setStudioFocus(
  db: Database,
  userId: string,
  input: {
    imageId: string;
    focalX: number;
    focalY: number;
    files: StudioImageFiles;
  },
  store?: PhotoStore,
): Promise<{ studio: MyStudio; handle: string; published: boolean }> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const rows = await putFiles(store, input.imageId, profileId, input.files);
    let old: string[] = [];
    let handle = '';
    let published = false;
    try {
      await db.transaction(async (tx) => {
        const page = await lockProPage(tx, profileId);
        handle = page.handle;
        const [image] = await tx
          .select({ id: studioImages.id })
          .from(studioImages)
          .where(
            and(
              eq(studioImages.id, input.imageId),
              eq(studioImages.profileId, profileId),
            ),
          )
          .for('update');
        if (!image) throw new OperationError('STUDIO_IMAGE_NOT_FOUND');
        const previous = await tx
          .delete(studioImageFiles)
          .where(
            and(
              eq(studioImageFiles.imageId, input.imageId),
              ne(studioImageFiles.name, 'master'),
            ),
          )
          .returning({ key: studioImageFiles.objectKey });
        old = previous.flatMap((p) => (p.key ? [p.key] : []));
        await tx.insert(studioImageFiles).values(rows);
        await tx
          .update(studioImages)
          .set({
            focalX: input.focalX,
            focalY: input.focalY,
            version: sql`${studioImages.version} + 1`,
          })
          .where(eq(studioImages.id, input.imageId));
        const [row] = await tx
          .select({ published: pageStudios.published })
          .from(pageStudios)
          .where(eq(pageStudios.profileId, profileId));
        published = Boolean(
          row?.published &&
          studioImageIds(resolveStudio(row.published, lagosToday())).has(
            input.imageId,
          ),
        );
      });
    } catch (error) {
      await removeObjects(
        store,
        rows.flatMap((r) => (r.objectKey ? [r.objectKey] : [])),
      );
      throw error;
    }
    await removeObjects(store, old);
    return { studio: await myStudioOf(db, profileId), handle, published };
  });
}

/**
 * A crop to serve publicly: only the current version of a photo the published version of a live,
 * active Pro page uses. Never the master.
 */
export function studioImageFile(
  db: Database,
  input: { profileId: string; imageId: string; version: number; file: string },
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    if (input.file === 'master') return null;
    const [row] = await db
      .select({ published: pageStudios.published })
      .from(studioImages)
      .innerJoin(profiles, eq(profiles.id, studioImages.profileId))
      .innerJoin(pageStudios, eq(pageStudios.profileId, studioImages.profileId))
      .where(
        and(
          eq(studioImages.id, input.imageId),
          eq(studioImages.profileId, input.profileId),
          eq(studioImages.version, input.version),
          eq(profiles.pageState, 'live'),
          eq(profiles.status, 'active'),
          eq(profiles.plan, 'pro'),
        ),
      );
    if (!row?.published) return null;
    if (
      !studioImageIds(resolveStudio(row.published, lagosToday())).has(
        input.imageId,
      )
    )
      return null;
    return fileBytes(db, input.imageId, input.file, store);
  });
}

/** The owner's own crop of any of their photos, for the editor; whatever the page's state. */
export function myStudioImageFile(
  db: Database,
  userId: string,
  input: { imageId: string; version: number; file: string },
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    if (input.file === 'master') return null;
    const profileId = await myPageId(db, userId);
    const [image] = await db
      .select({ id: studioImages.id })
      .from(studioImages)
      .where(
        and(
          eq(studioImages.id, input.imageId),
          eq(studioImages.profileId, profileId),
          eq(studioImages.version, input.version),
        ),
      );
    return image ? fileBytes(db, input.imageId, input.file, store) : null;
  });
}

/**
 * The published design for the public page, or undefined: only for a Pro page whose published
 * version passes today's design check with today's facts. A version a newer rule (or a removed
 * photo, a gone video) now fails shows the standard page instead; the editor lists the fixes.
 */
export async function publicStudioFor(
  db: Db,
  page: PageFacts,
): Promise<PublicStudio | undefined> {
  if (page.plan !== 'pro') return undefined;
  const [row] = await db
    .select({ published: pageStudios.published })
    .from(pageStudios)
    .where(eq(pageStudios.profileId, page.id));
  if (!row?.published) return undefined;
  const document = resolveStudio(row.published, lagosToday());
  const images = await imagesOf(db, page.id);
  const { issues } = checkDesign(
    document,
    await contextFor(db, page, document, images),
  );
  if (issues.length) return undefined;
  const used = studioImageIds(document);
  return {
    document,
    palette: deriveStudioPalette(document.brand),
    images: Object.fromEntries(
      images
        .filter((i) => used.has(i.id))
        .map((i) => [
          i.id,
          {
            path: studioImagePathOf(page.id, i.id, i.version),
            width: i.width,
            height: i.height,
          },
        ]),
    ),
    checkVersion: DESIGN_CHECK_VERSION,
  };
}

/**
 * The page facts the design check reads, from a profiles row: only what the person made public,
 * since that is what the About and Links blocks show.
 */
export function studioPageFacts(row: {
  id: string;
  handleLower: string;
  plan: string;
  bio: string | null;
  bioPublic: boolean;
  links: SocialLink[];
  socialsPublic: boolean;
}): PageFacts {
  return {
    id: row.id,
    handle: row.handleLower,
    plan: row.plan as PagePlan,
    bio: row.bioPublic ? row.bio : null,
    links: row.socialsPublic ? row.links : [],
  };
}

/** One Studio photo's master as staff see it, whatever the page's state; audited. */
export function staffViewStudioImage(
  db: Database,
  input: { staffUserId: string; profileId: string; imageId: string },
  store?: PhotoStore,
): Promise<Buffer | null> {
  return guarded(async () => {
    const [image] = await db
      .select({ id: studioImages.id })
      .from(studioImages)
      .innerJoin(profiles, eq(profiles.id, studioImages.profileId))
      .where(
        and(
          eq(studioImages.id, input.imageId),
          eq(studioImages.profileId, input.profileId),
          ne(profiles.pageState, 'deleted'),
        ),
      );
    if (!image) return null;
    const bytes = await fileBytes(db, input.imageId, 'master', store);
    if (!bytes) return null;
    await recordAudit(db, {
      staffUserId: input.staffUserId,
      action: 'page.studio_photo_viewed',
      permission: 'pages.suspend',
      subjectType: 'profile',
      subjectId: input.profileId,
    });
    return bytes;
  });
}

/**
 * Removes one Studio photo for good (owner ruling 9): it drops out of the draft and the published
 * version, its files go, and the owner is told, not why. Audited with the reason. Removing what's
 * already gone records and sends nothing.
 */
export function staffRemoveStudioImage(
  db: Database,
  input: {
    staffUserId: string;
    profileId: string;
    imageId: string;
    reason: string;
    sealing: MailSealing;
    store?: PhotoStore | undefined;
  },
): Promise<{ handle: string; changed: boolean }> {
  return guarded(async () => {
    const result = await db.transaction(async (tx) => {
      const [page] = await tx
        .select({ handle: profiles.handleLower })
        .from(profiles)
        .where(
          and(
            eq(profiles.id, input.profileId),
            ne(profiles.pageState, 'deleted'),
          ),
        )
        .for('update');
      if (!page) throw new OperationError('PROFILE_NOT_FOUND');
      const [image] = await tx
        .select({ id: studioImages.id })
        .from(studioImages)
        .where(
          and(
            eq(studioImages.id, input.imageId),
            eq(studioImages.profileId, input.profileId),
          ),
        );
      if (!image)
        return { handle: page.handle, keys: [] as string[], changed: false };
      const [row] = await tx
        .select()
        .from(pageStudios)
        .where(eq(pageStudios.profileId, input.profileId))
        .for('update');
      if (row) {
        const today = lagosToday();
        await tx
          .update(pageStudios)
          .set({
            draft: withoutStudioImage(
              resolveStudio(row.draft, today),
              input.imageId,
            ),
            published: row.published
              ? withoutStudioImage(
                  resolveStudio(row.published, today),
                  input.imageId,
                )
              : null,
            rev: sql`${pageStudios.rev} + 1`,
            updatedAt: sql`now()`,
          })
          .where(eq(pageStudios.profileId, input.profileId));
      }
      const files = await tx
        .select({ key: studioImageFiles.objectKey })
        .from(studioImageFiles)
        .where(eq(studioImageFiles.imageId, input.imageId));
      await tx.delete(studioImages).where(eq(studioImages.id, input.imageId));
      await recordAudit(tx, {
        staffUserId: input.staffUserId,
        action: 'page.studio_photo_removed',
        permission: 'pages.suspend',
        subjectType: 'profile',
        subjectId: input.profileId,
        reason: input.reason,
      });
      await mailOwner(tx, input.sealing, {
        profileId: input.profileId,
        type: 'page_image_removed',
        data: { image: 'studio_photo' },
        dedupeKey: `page_image_removed.${input.profileId}.${newId()}`,
      });
      return {
        handle: page.handle,
        keys: files.flatMap((f) => (f.key ? [f.key] : [])),
        changed: true,
      };
    });
    await removeObjects(input.store, result.keys);
    return { handle: result.handle, changed: result.changed };
  });
}

/** Account deletion: the page's Studio rows and photos go with it. Returns object keys to remove. */
export async function deleteStudioData(
  tx: Tx,
  profileId: string,
): Promise<string[]> {
  await tx.delete(pageStudios).where(eq(pageStudios.profileId, profileId));
  return dropUnused(tx, profileId, new Set());
}
