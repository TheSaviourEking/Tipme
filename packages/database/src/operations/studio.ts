import { randomUUID } from 'node:crypto';
import {
  DESIGN_CHECK_VERSION,
  STUDIO_LIMITS,
  checkDesign,
  defaultStudioDocument,
  photoAccentOf,
  photoAccentSchema,
  proItemsOf,
  resolveCover,
  resolveStudio,
  resolveStudioV1,
  studioDocumentSchema,
  studioDraftRefusal,
  studioImageIdsOf,
  studioShown,
  studioTokens,
  visibleLinks,
  type MyStudio,
  type PagePlan,
  type PhotoAccent,
  type PublicStudio,
  type SocialLink,
  type StudioBlock,
  type StudioBlockV1,
  type StudioCheckContext,
  type StudioDocument,
  type StudioDocumentV1,
  type StudioIssue,
} from '@tipme/contracts';
import {
  and,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  ne,
  notInArray,
  sql,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import type { PhotoStore } from '../photo-store.js';
import {
  pageStudios,
  profileAvatars,
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

// Page Studio storage (plan 2026-11-12-page-studio, Task 7; styles plan Task 10). A page keeps a
// draft and a published version; saving never needs a passing design check, publishing always
// does, with the server's own facts (photo sizes, video status, the page's bio, links, plan, cover
// and avatar). Photos are stored as covers are: re-encoded on the server, each file in Postgres or
// in R2, objects written before their rows and removed after the change commits.
//
// v2 only since the editor moved to v2 (styles plan ruling R1, PR 4a): a draft saves on any plan
// under the Free and Pro draft rules (§11, `studioDraftRefusal`), and a v1 document is refused as
// STUDIO_DRAFT_INVALID. A draft the old editor stored as v1 reads as v2 (`resolveStudio`, the §7.1
// migration), so the editor sees what publishing stores. Publishing always stores v2 and runs the
// v3 check with the page's real plan. The public page shows
// what `studioShown` makes of the published version for the plan now (§12.5): nothing is deleted
// when Pro lapses, and it all comes back with Pro. Photo uploads and focus changes are Pro only.

type Db = Database | Tx;
/**
 * A stored row as read, in its own format: rows the old editor saved can still hold v1, so the
 * photo and video bookkeeping reads both. The editor only ever sees v2 (myStudioOf).
 */
type AnyStudio = StudioDocumentV1 | StudioDocument;

const isV2 = (doc: AnyStudio): doc is StudioDocument => doc.v === 2;

/** A stored draft or published version, in its own format. Never throws. */
function readStored(raw: unknown, today: string): AnyStudio {
  return typeof raw === 'object' &&
    raw !== null &&
    (raw as { v?: unknown }).v === 2
    ? resolveStudio(raw, today)
    : resolveStudioV1(raw, today);
}

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

/** Every image id a document uses: photos, gallery photos and (v1) photo row backgrounds. */
export function studioImageIds(doc: AnyStudio): Set<string> {
  if (isV2(doc)) return studioImageIdsOf(doc);
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
export function studioVideoUrls(doc: AnyStudio): string[] {
  if (isV2(doc))
    return [
      ...new Set(
        doc.blocks.flatMap((b) => (b.kind === 'video' ? [b.url] : [])),
      ),
    ];
  return [
    ...new Set(
      doc.rows.flatMap((row) =>
        row.cells.flat().flatMap((b) => (b.kind === 'video' ? [b.url] : [])),
      ),
    ),
  ];
}

/** The document without one photo: its blocks go, a gallery left empty goes, a row's photo goes. */
export function withoutStudioImage<D extends AnyStudio>(
  doc: D,
  imageId: string,
): D;
export function withoutStudioImage(doc: AnyStudio, imageId: string): AnyStudio {
  if (isV2(doc))
    return {
      ...doc,
      blocks: doc.blocks.flatMap((b): StudioBlock[] => {
        if (b.kind === 'photo' && b.imageId === imageId) return [];
        if (b.kind !== 'gallery') return [b];
        const images = b.images.filter((i) => i.imageId !== imageId);
        if (images.length === b.images.length) return [b];
        return images.length ? [{ ...b, images }] : [];
      }),
    };
  return {
    ...doc,
    rows: doc.rows.map((row) => ({
      ...row,
      background:
        typeof row.background === 'object' && row.background.photo === imageId
          ? 'page'
          : row.background,
      cells: row.cells.map((cell) =>
        cell.flatMap((b): StudioBlockV1[] => {
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
  /** The display name, for the check's name-fallback notice. */
  name: string;
  hasAvatar: boolean;
  /** The profile photo a stored photo accent must have come from; null without a photo. */
  avatar: { avatarVersion: number } | null;
  /** The cover set in Settings, as the v3 check reads it. */
  coverKind: StudioCheckContext['coverKind'];
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
      displayName: profiles.displayName,
      avatarPath: profiles.avatarPath,
      avatarVersion: profiles.avatarVersion,
      coverPath: profiles.coverPath,
      coverDesign: profiles.coverDesign,
      coverAnimation: profiles.coverAnimation,
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
  /** The largest stored file (the master, at the photo's own width): the v3 check scales it. */
  masterBytes: number;
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
    masterBytes: Math.max(
      0,
      ...files.filter((f) => f.imageId === r.id).map((f) => f.size),
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

/** The v3 check's facts: the v1 ones, the name, and the page's plan, cover and avatar now. */
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
        { width: i.width, height: i.height, bytes: i.masterBytes },
      ]),
    ),
    videos,
    profile: {
      name: page.name,
      bio: Boolean(page.bio),
      links: linkCount(page),
    },
    plan: page.plan === 'pro' ? 'pro' : 'free',
    coverKind: page.coverKind,
    hasAvatar: page.hasAvatar,
  };
}

async function myStudioOf(db: Db, profileId: string): Promise<MyStudio> {
  const page = await pageFacts(db, profileId);
  const [row] = await db
    .select()
    .from(pageStudios)
    .where(eq(pageStudios.profileId, profileId));
  const today = lagosToday();
  // Always v2: a draft the old editor stored as v1 reads through the §7.1 migration.
  const draft = row ? resolveStudio(row.draft, today) : defaultStudioDocument();
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
    // Every page edits (§5.4): Free saves and publishes free styles; the server refuses the rest.
    access: 'edit',
    plan: page.plan === 'pro' ? 'pro' : 'free',
    photoAccent: photoAccentOf(row?.photoAccent ?? null, page.avatar),
  };
}

/** The owner's Studio: the draft, the published version, the check and the photos. */
export function getMyStudio(db: Database, userId: string): Promise<MyStudio> {
  return guarded(async () => myStudioOf(db, await myPageId(db, userId)));
}

/**
 * Locks the page and reads its facts under the lock. A plan change takes the same row lock
 * (recomputePlan), so the plan read here holds until the change commits.
 */
async function lockPage(tx: Tx, profileId: string) {
  await lockLivePage(tx, profileId);
  return pageFacts(tx, profileId);
}

/** Locks the page and refuses a page that isn't Pro (now, under the lock). */
async function lockProPage(tx: Tx, profileId: string) {
  const page = await lockPage(tx, profileId);
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
 * Saves the draft if it was based on the latest revision; STUDIO_DRAFT_STALE otherwise, keeping
 * the newer one. Photos must be this page's own. Only a v2 draft saves (ruling R1): anything else,
 * the old editor's v1 included, is STUDIO_DRAFT_INVALID. It saves on any plan, except that on Free
 * it may not add a Pro style, the photo accent or a Pro block that neither the stored draft nor
 * the published version holds (§11, R4): STUDIO_PRO_REQUIRED.
 */
export function saveStudioDraft(
  db: Database,
  userId: string,
  input: { rev: number; draft: StudioDocument },
): Promise<MyStudio> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const next = input.draft;
    // The API's pipe checked it; checked again here, as nothing else may reach the column.
    if (!studioDocumentSchema.safeParse(next).success)
      throw new OperationError('STUDIO_DRAFT_INVALID');
    await db.transaction(async (tx) => {
      const page = await lockPage(tx, profileId);
      const used = [...studioImageIds(next)];
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
        .select({
          rev: pageStudios.rev,
          draft: pageStudios.draft,
          published: pageStudios.published,
        })
        .from(pageStudios)
        .where(eq(pageStudios.profileId, profileId))
        .for('update');
      if ((row?.rev ?? 0) !== input.rev)
        throw new OperationError('STUDIO_DRAFT_STALE');
      const today = lagosToday();
      const refusal = studioDraftRefusal(
        next,
        {
          draft: row ? resolveStudio(row.draft, today) : null,
          published: row?.published
            ? resolveStudio(row.published, today)
            : null,
        },
        page.plan === 'pro' ? 'pro' : 'free',
      );
      if (refusal) throw new OperationError(refusal);
      if (!row)
        await tx.insert(pageStudios).values({ profileId, draft: next, rev: 1 });
      else
        await tx
          .update(pageStudios)
          .set({
            draft: next,
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
 * Publishes the draft, as v2, when the v3 design check passes with the server's facts and the
 * page's plan read under the page lock; otherwise nothing changes and the issues come back (there
 * is no "publish anyway", owner ruling 12). A Free page publishing anything Pro gets `pro-only`.
 * When the version uses anything Pro, the write also requires the plan to be Pro, as setThanks
 * does, so a plan change can never put a Pro design live. The draft is kept as it was. Photos used by
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
      const page = await lockPage(tx, profileId);
      const [row] = await tx
        .select()
        .from(pageStudios)
        .where(eq(pageStudios.profileId, profileId))
        .for('update');
      if (!row || row.rev !== input.rev)
        throw new OperationError('STUDIO_DRAFT_STALE');
      const today = lagosToday();
      const version = resolveStudio(row.draft, today);
      const context = await contextFor(tx, page, version);
      const { issues } = checkDesign(version, context);
      if (issues.length) return { issues, keys: [] as string[] };
      const pro = proItemsOf(version);
      const needsPro = pro.style || pro.photoAccent || pro.blockIds.length > 0;
      // Backup, not the gate: the plan above was read under the page's row lock, which a plan
      // change also takes (recomputePlan), so it can't change before this commits, and the check
      // has already refused Pro on Free (tested: "a plan change during publish cannot put a Pro
      // style live"). The write still requires Pro, as setThanks does, in case anything ever
      // changes the plan without that lock; it can't be reached while the lock holds.

      const written = await tx
        .update(pageStudios)
        .set({
          published: version,
          publishedCheckVersion: DESIGN_CHECK_VERSION,
          publishedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(pageStudios.profileId, profileId),
            ...(needsPro
              ? [
                  inArray(
                    pageStudios.profileId,
                    tx
                      .select({ id: profiles.id })
                      .from(profiles)
                      .where(
                        and(
                          eq(profiles.id, profileId),
                          eq(profiles.plan, 'pro'),
                        ),
                      ),
                  ),
                ]
              : []),
          ),
        )
        .returning({ id: pageStudios.profileId });
      if (written.length === 0)
        return {
          issues: checkDesign(version, { ...context, plan: 'free' }).issues,
          keys: [] as string[],
        };
      const keep = new Set([
        ...studioImageIds(version),
        ...studioImageIds(readStored(row.draft, today)),
      ]);
      const keys = await dropUnused(tx, profileId, keep);
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
      // Any plan: a lapsed Pro draft can be discarded too (§11).
      await lockLivePage(tx, profileId);
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
        studioImageIds(readStored(row.published, lagosToday())),
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
          studioImageIds(readStored(row.published, lagosToday())).has(
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
 * active Pro page uses. Never the master. On Free every photo block is hidden (§12.5), so none
 * is served.
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
      !studioImageIdsOf(resolveStudio(row.published, lagosToday())).has(
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
 * The published design for the public page, or undefined for the standard page: the published
 * version (v2; a stored v1 is read as v2) as the page's plan shows it now (`studioShown`, §12.5),
 * when that passes today's design check with today's facts. A version a newer rule (or a removed
 * photo, a gone video) now fails shows the standard page instead; the editor lists the fixes.
 * Only the photos the shown version uses are listed.
 */
export async function publicStudioFor(
  db: Db,
  page: PageFacts,
): Promise<PublicStudio | undefined> {
  const [row] = await db
    .select({
      published: pageStudios.published,
      photoAccent: pageStudios.photoAccent,
    })
    .from(pageStudios)
    .where(eq(pageStudios.profileId, page.id));
  if (!row?.published) return undefined;
  const document = studioShown(
    resolveStudio(row.published, lagosToday()),
    page.plan === 'pro' ? 'pro' : 'free',
  );
  if (!document) return undefined;
  const images = await imagesOf(db, page.id);
  const { issues } = checkDesign(
    document,
    await contextFor(db, page, document, images),
  );
  if (issues.length) return undefined;
  const used = studioImageIdsOf(document);
  return {
    document,
    // "From your photo" (§6): the stored values for the current photo, or their fallback. With
    // no photo, or one newer than the stored values, the style's own accent: never a stale one.
    // On Free `studioShown` has already set the photo accent back to the style's own.
    palette: studioTokens(
      document.style,
      document.accent,
      photoAccentOf(row.photoAccent, page.avatar),
    ),
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

/** The cover set in Settings, as the check reads it (photo, design, automatic or animated). */
function coverKindOf(row: {
  handleLower: string;
  plan: string;
  coverPath: string | null;
  coverDesign: string | null;
  coverAnimation: string | null;
}): StudioCheckContext['coverKind'] {
  const cover = resolveCover({
    handle: row.handleLower,
    coverPath: row.coverPath,
    coverDesign: row.coverDesign,
    coverColour: null,
    coverAnimation: row.coverAnimation,
    plan: row.plan,
  });
  if (cover.kind !== 'design') return cover.kind;
  // A design nobody chose (or one since removed from the catalogue) is the automatic one.
  return cover.design === row.coverDesign ? 'design' : 'automatic';
}

/**
 * The page facts the design check reads, from a profiles row: only what the person made public,
 * since that is what the page shows.
 */
export function studioPageFacts(row: {
  id: string;
  handleLower: string;
  plan: string;
  bio: string | null;
  bioPublic: boolean;
  links: SocialLink[];
  socialsPublic: boolean;
  displayName: string;
  avatarPath: string | null;
  avatarVersion: number;
  coverPath: string | null;
  coverDesign: string | null;
  coverAnimation: string | null;
}): PageFacts {
  return {
    id: row.id,
    handle: row.handleLower,
    plan: row.plan as PagePlan,
    bio: row.bioPublic ? row.bio : null,
    links: row.socialsPublic ? row.links : [],
    name: row.displayName,
    hasAvatar: row.avatarPath !== null,
    avatar:
      row.avatarPath !== null ? { avatarVersion: row.avatarVersion } : null,
    coverKind: coverKindOf(row),
  };
}

// ---------------------------------------------------------------------------------------------
// "From your photo" (styles spec §6). The API samples the profile photo and stores what
// `pickPhotoAccent` made of it; only the server writes the column, and only for the photo it
// sampled. Reads go through `photoAccentOf`, so a value for an older photo is never shown.

/**
 * The page's profile photo, to compute its photo accent from: its version and bytes (null when
 * they can't be read, e.g. an object store without the object). Null when the page has no Studio
 * row (nothing would use it) or no photo.
 */
export function studioPhotoSource(
  db: Database,
  userId: string,
  store?: PhotoStore,
): Promise<{
  profileId: string;
  avatarVersion: number;
  webp: Buffer | null;
} | null> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    const [row] = await db
      .select({
        version: profileAvatars.version,
        bytes: profileAvatars.bytes,
        objectKey: profileAvatars.objectKey,
      })
      .from(profileAvatars)
      .innerJoin(
        pageStudios,
        eq(pageStudios.profileId, profileAvatars.profileId),
      )
      .where(eq(profileAvatars.profileId, profileId));
    if (!row) return null;
    const webp =
      row.bytes ??
      (row.objectKey && store ? await store.get(row.objectKey) : null);
    return { profileId, avatarVersion: row.version, webp: webp ?? null };
  });
}

/**
 * Stores the photo accent computed from photo `avatarVersion`, or clears it (null: that photo
 * could not be sampled), only while that is still the page's photo (a newer upload or a removal
 * in the meantime wins). Returns whether it was written.
 */
export function setPhotoAccent(
  db: Database,
  profileId: string,
  avatarVersion: number,
  accent: PhotoAccent | null,
): Promise<boolean> {
  return guarded(async () => {
    // Only the server's own values reach the column, and from there the page's CSS.
    const value = accent === null ? null : photoAccentSchema.parse(accent);
    if (value && value.avatarVersion !== avatarVersion)
      throw new OperationError('STUDIO_DRAFT_INVALID');
    const written = await db
      .update(pageStudios)
      .set({ photoAccent: value })
      .where(
        and(
          eq(pageStudios.profileId, profileId),
          inArray(
            pageStudios.profileId,
            db
              .select({ id: profiles.id })
              .from(profiles)
              .where(
                and(
                  eq(profiles.id, profileId),
                  eq(profiles.avatarVersion, avatarVersion),
                  isNotNull(profiles.avatarPath),
                ),
              ),
          ),
        ),
      )
      .returning({ id: pageStudios.profileId });
    return written.length > 0;
  });
}

/**
 * Clears the page's photo accent once its photo is gone; a photo uploaded in the meantime keeps
 * the accent stored for it.
 */
export function clearPhotoAccent(db: Database, userId: string): Promise<void> {
  return guarded(async () => {
    const profileId = await myPageId(db, userId);
    await db
      .update(pageStudios)
      .set({ photoAccent: null })
      .where(
        and(
          eq(pageStudios.profileId, profileId),
          inArray(
            pageStudios.profileId,
            db
              .select({ id: profiles.id })
              .from(profiles)
              .where(
                and(eq(profiles.id, profileId), isNull(profiles.avatarPath)),
              ),
          ),
        ),
      );
  });
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
              readStored(row.draft, today),
              input.imageId,
            ),
            published: row.published
              ? withoutStudioImage(
                  readStored(row.published, today),
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
