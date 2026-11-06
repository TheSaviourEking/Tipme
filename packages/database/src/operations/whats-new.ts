import {
  CHANGELOG_AUDIENCES,
  shownToUser,
  userLine,
  type ChangelogUserAudience,
  type PagePlan,
  type WhatsNewEntry,
  type WhatsNewList,
  type WhatsNewStatus,
} from '@tipme/contracts';
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  ne,
  sql,
} from 'drizzle-orm';
import type { Database } from '../client.js';
import { changelogEntries, changelogReads, profiles } from '../schema.js';
import { guarded, OperationError } from './errors.js';

/**
 * What's new for users (changelog plan, Task 6.1). Users read only the published (approved) copy
 * of entries that are live in production and not withdrawn, filtered by `shownToUser`. When each
 * person last looked is kept on the server (`changelog_reads`), so the dot and the Home slip show
 * once per update on any device.
 */

/** At most this many entries on the page. */
export const WHATS_NEW_LIMIT = 50;

/**
 * Whether a page has early access on. Early access isn't built yet, so this is false for every page
 * today. hook: feat/early-access — once `profiles.early_access` exists, the full profile row read
 * below carries `earlyAccess` and this follows it with no other change.
 */
export function earlyAccessOf(profile: object): boolean {
  return (profile as { earlyAccess?: unknown }).earlyAccess === true;
}

interface Reader {
  /** The audiences this page may read, decided by shownToUser so the rule lives in one place. */
  audiences: ChangelogUserAudience[];
  /** Updates live after this are new to them. */
  seenThrough: Date;
}

async function reader(db: Database, userId: string): Promise<Reader> {
  // The whole profile row, so earlyAccessOf sees a future early_access column without an edit here.
  const [row] = await db
    .select({ profile: profiles, seenThrough: changelogReads.seenThrough })
    .from(profiles)
    .leftJoin(changelogReads, eq(changelogReads.userId, profiles.userId))
    .where(and(eq(profiles.userId, userId), ne(profiles.pageState, 'deleted')));
  if (!row) throw new OperationError('NO_PAGE');
  const who = {
    plan: row.profile.plan as PagePlan,
    earlyAccess: earlyAccessOf(row.profile),
  };
  return {
    audiences: CHANGELOG_AUDIENCES.filter(
      (audience): audience is ChangelogUserAudience =>
        audience !== 'staff' &&
        shownToUser({ publishedAudience: audience }, who),
    ),
    // A person who never looked starts at the day they joined: no dot for older updates.
    seenThrough: row.seenThrough ?? row.profile.createdAt,
  };
}

function entries(db: Database, who: Reader, limit: number) {
  return db
    .select({
      number: changelogEntries.prNumber,
      text: changelogEntries.publishedText,
      audience: changelogEntries.publishedAudience,
      liveAt: changelogEntries.liveAt,
      liveOn: sql<string>`to_char(${changelogEntries.liveAt} AT TIME ZONE 'Africa/Lagos', 'YYYY-MM-DD')`,
      unseen: sql<number>`(count(*) FILTER (WHERE ${changelogEntries.liveAt} > ${who.seenThrough.toISOString()}::timestamptz) OVER ())::int`,
    })
    .from(changelogEntries)
    .where(
      and(
        isNull(changelogEntries.withdrawnAt),
        isNotNull(changelogEntries.publishedRevision),
        isNotNull(changelogEntries.liveAt),
        inArray(changelogEntries.publishedAudience, who.audiences),
      ),
    )
    .orderBy(desc(changelogEntries.liveAt), desc(changelogEntries.prNumber))
    .limit(limit);
}

type EntryRow = Awaited<ReturnType<typeof entries>>[number];

function toEntry(row: EntryRow): WhatsNewEntry {
  const audience = row.audience as ChangelogUserAudience;
  return {
    number: row.number,
    line: userLine({ text: row.text ?? '', audience }),
    pro: audience !== 'everyone',
    liveOn: row.liveOn,
    liveAt: row.liveAt!.toISOString(),
  };
}

/** The signed-in person's What's new, newest first, and how many of those are new to them. */
export function listWhatsNew(
  db: Database,
  userId: string,
): Promise<WhatsNewList> {
  return guarded(async () => {
    const who = await reader(db, userId);
    if (who.audiences.length === 0) return { entries: [], unseen: 0 };
    const rows = await entries(db, who, WHATS_NEW_LIMIT);
    return { entries: rows.map(toEntry), unseen: rows[0]?.unseen ?? 0 };
  });
}

/** For the dot and the Home slip: how many are new, and the newest line. One indexed read. */
export function whatsNewStatus(
  db: Database,
  userId: string,
): Promise<WhatsNewStatus> {
  return guarded(async () => {
    const who = await reader(db, userId);
    if (who.audiences.length === 0) return { unseen: 0, newest: null };
    const [row] = await entries(db, who, 1);
    return row
      ? { unseen: row.unseen, newest: toEntry(row) }
      : { unseen: 0, newest: null };
  });
}

/**
 * Marks What's new seen up to `through`. The marker only moves forward (a stale tab can't move it
 * back) and never past now (a wrong clock can't hide updates that haven't gone live yet).
 */
export function markWhatsNewSeen(
  db: Database,
  input: { userId: string; through: Date; now?: Date },
): Promise<void> {
  const now = input.now ?? new Date();
  const through = input.through < now ? input.through : now;
  return guarded(async () => {
    await db
      .insert(changelogReads)
      .values({ userId: input.userId, seenThrough: through })
      .onConflictDoUpdate({
        target: changelogReads.userId,
        set: {
          seenThrough: sql`GREATEST(${changelogReads.seenThrough}, excluded.seen_through)`,
        },
      });
  });
}
