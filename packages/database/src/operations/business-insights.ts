import { createHash } from 'node:crypto';
import {
  BUSINESS_NOTE_TAGS,
  MIN_GROUP,
  shownCount,
  type BusinessNoteTag,
  type BusinessNoteView,
  type BusinessStatus,
  type LocationInsights,
  type MemberWeek,
  type MyMembership,
  type Shown,
} from '@tipme/contracts';
import { LAGOS_TIME_ZONE, lagosWeekRange, onShift } from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { managerOf, ownMembership } from './business-access.js';
import { OperationError, guarded } from './errors.js';

// TipMe for businesses, PR B7: what the business sees. The privacy core (plan B7, M5, M6, Q5):
// - every count goes through `shownCount`, so 1 and 2 never leave the server as numbers;
// - naira only for a person who shares them, and only in a week with at least 3 of their tips;
// - nothing from a supporter: no name, message, time, single amount or reference;
// - people who left fold into the location total, with no row, name or notes.

const TAG_IDS = BUSINESS_NOTE_TAGS.map((tag) => tag.id) as BusinessNoteTag[];

/**
 * The reference a business uses for a note. Never the tip's id: tip ids are UUIDv7, whose first
 * 48 bits are the millisecond the tip was started, which would give away the time of the visit.
 * A one-way hash of the id, shaped like a UUID; `noteTipOf` finds the tip again for a manager.
 */
export function businessNoteRef(tipId: string): string {
  const hex = createHash('sha256')
    .update(`business-note:${tipId}`)
    .digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The tip behind a business's note reference, among the notes of that business only; null when
 * there is none. For the manager's report route (B5), which receives the reference, not a tip id.
 */
export async function noteTipOf(
  db: Database,
  businessId: string,
  ref: string,
): Promise<string | null> {
  if (!REF.test(ref)) return null;
  const rows = await db.execute<{ tip_id: string }>(sql`
    SELECT n.tip_id
      FROM business_notes n
      JOIN business_members m ON m.id = n.member_id
      JOIN business_locations l ON l.id = m.location_id
     WHERE l.business_id = ${businessId}
       AND left(encode(sha256(convert_to('business-note:' || n.tip_id::text, 'UTF8')), 'hex'), 32)
           = ${ref.replaceAll('-', '')}`);
  return rows.rows[0]?.tip_id ?? null;
}

function weekOf(week: string): { from: Date; to: Date } {
  const range = lagosWeekRange(week);
  if (!range) throw new OperationError('INVALID_INPUT');
  return range;
}

/** A note the business may read: not waiting on a report, not removed by TipMe. */
const visibleNote = sql`(n.tip_id IS NOT NULL AND (f.tip_id IS NULL OR f.outcome = 'restored'))`;

/** Paid tips made at this location in this Lagos week, rehearsal pages left out. */
const paidAt = (locationId: string, range: { from: Date; to: Date }) => sql`
  FROM tips t
  JOIN profiles p ON p.id = t.profile_id
  JOIN business_members m ON m.id = t.business_member_id
  LEFT JOIN business_notes n ON n.tip_id = t.id
  LEFT JOIN business_note_flags f ON f.tip_id = n.tip_id
 WHERE t.business_location_id = ${locationId}
   AND t.status = 'SUCCEEDED'
   AND t.completed_at >= ${range.from} AND t.completed_at < ${range.to}
   AND p.rehearsal_run_id IS NULL`;

/** Rank: a count the business may see; every count under 3 shares one rank below 3. */
const rankOf = (shown: Shown) => ('n' in shown ? shown.n : MIN_GROUP - 1);

/**
 * One location's week, for a manager of it. A location manager of another location, someone who
 * doesn't manage the business, or another business's location: NOT_A_MANAGER (404).
 */
export async function locationInsights(
  db: Database,
  userId: string,
  businessId: string,
  q: { locationId: string; week: string },
): Promise<LocationInsights> {
  const range = weekOf(q.week);
  await managerOf(db, userId, businessId, { locationId: q.locationId });
  return guarded(async () => {
    const rows = await db.execute<{
      member_id: string;
      active: boolean;
      shown_name: string;
      share_amounts: boolean;
      net: string;
      dow: number;
      hour: number;
      has_note: boolean;
      tags: string[] | null;
    }>(sql`
      SELECT t.business_member_id AS member_id, m.left_at IS NULL AS active,
             m.shown_name, m.share_amounts,
             (SELECT q.recipient_net_minor::text
                FROM payment_intents i JOIN tip_quotes q ON q.id = i.quote_id
               WHERE i.id = t.intent_id) AS net,
             extract(dow FROM t.completed_at AT TIME ZONE ${LAGOS_TIME_ZONE})::int AS dow,
             extract(hour FROM t.completed_at AT TIME ZONE ${LAGOS_TIME_ZONE})::int AS hour,
             ${visibleNote} AS has_note, n.tags
      ${paidAt(q.locationId, range)}`);

    type Person = {
      shownName: string;
      share: boolean;
      tips: number;
      notes: number;
      net: bigint;
      tags: Record<BusinessNoteTag, number>;
    };
    const people = new Map<string, Person>();
    const byHour = new Map<string, number>();
    const locationTags = Object.fromEntries(
      TAG_IDS.map((tag) => [tag, 0]),
    ) as Record<BusinessNoteTag, number>;
    let visibleNotes = 0;
    for (const row of rows.rows) {
      const key = `${row.dow}:${row.hour}`;
      byHour.set(key, (byHour.get(key) ?? 0) + 1);
      // Someone who left counts in the total and the hours only (M6).
      if (!row.active) continue;
      let person = people.get(row.member_id);
      if (!person) {
        person = {
          shownName: row.shown_name,
          share: row.share_amounts,
          tips: 0,
          notes: 0,
          net: 0n,
          tags: Object.fromEntries(TAG_IDS.map((tag) => [tag, 0])) as Record<
            BusinessNoteTag,
            number
          >,
        };
        people.set(row.member_id, person);
      }
      person.tips += 1;
      person.net += BigInt(row.net);
      if (row.has_note) {
        person.notes += 1;
        visibleNotes += 1;
        for (const tag of row.tags ?? [])
          if (tag in person.tags) {
            person.tags[tag as BusinessNoteTag] += 1;
            locationTags[tag as BusinessNoteTag] += 1;
          }
      }
    }

    const weekRows: MemberWeek[] = [...people.entries()].map(
      ([memberId, person]) => ({
        memberId,
        shownName: person.shownName,
        left: false,
        tips: shownCount(person.tips),
        notes: shownCount(person.notes),
        tags: Object.fromEntries(
          TAG_IDS.map((tag) => [tag, shownCount(person.tags[tag])]),
        ) as Record<BusinessNoteTag, Shown>,
        ...(person.share && person.tips >= MIN_GROUP
          ? { amountMinor: person.net.toString() }
          : {}),
      }),
    );
    // Never order by a count the business can't see: everyone under 3 sorts by name together.
    weekRows.sort(
      (a, b) =>
        rankOf(b.tips) - rankOf(a.tips) ||
        (a.shownName ?? '').localeCompare(b.shownName ?? '') ||
        (a.memberId ?? '').localeCompare(b.memberId ?? ''),
    );

    // The busiest 2-hour window, Monday first; the earliest wins a tie. Day 0 is Sunday.
    let busiest: LocationInsights['busiest'];
    let most = MIN_GROUP - 1;
    for (const day of [1, 2, 3, 4, 5, 6, 0] as const)
      for (let hour = 0; hour <= 22; hour += 1) {
        const count =
          (byHour.get(`${day}:${hour}`) ?? 0) +
          (byHour.get(`${day}:${hour + 1}`) ?? 0);
        if (count > most) {
          most = count;
          busiest = { day, fromHour: hour, toHour: hour + 2 };
        }
      }

    // The most-used tag, as a share of visible notes: at least 3 notes, and the tag on 3 or more.
    let topTag: LocationInsights['topTag'];
    if (visibleNotes >= MIN_GROUP) {
      let best = MIN_GROUP - 1;
      for (const tag of TAG_IDS)
        if (locationTags[tag] > best) {
          best = locationTags[tag];
          topTag = {
            tag,
            percent: Math.round((100 * locationTags[tag]) / visibleNotes),
          };
        }
    }

    return {
      week: q.week,
      locationId: q.locationId,
      tips: shownCount(rows.rows.length),
      people: weekRows,
      ...(busiest ? { busiest } : {}),
      ...(topTag ? { topTag } : {}),
    };
  });
}

/**
 * The notes customers wrote about people at one location that week, newest date first. Only
 * visible notes about people still there; the Lagos date, never a time; nothing else from the tip.
 */
export async function businessNotes(
  db: Database,
  userId: string,
  businessId: string,
  q: { locationId: string; week: string },
): Promise<BusinessNoteView[]> {
  const range = weekOf(q.week);
  await managerOf(db, userId, businessId, { locationId: q.locationId });
  return guarded(async () => {
    const rows = await db.execute<{
      tip_id: string;
      shown_name: string;
      date: string;
      tags: string[];
      body: string | null;
    }>(sql`
      SELECT t.id AS tip_id, m.shown_name,
             to_char((t.completed_at AT TIME ZONE ${LAGOS_TIME_ZONE})::date, 'YYYY-MM-DD') AS date,
             n.tags, n.body
      ${paidAt(q.locationId, range)}
        AND m.left_at IS NULL
        AND ${visibleNote}`);
    const notes = rows.rows.map((row) => ({
      tipId: businessNoteRef(row.tip_id),
      shownName: row.shown_name,
      date: row.date,
      tags: row.tags.filter((tag): tag is BusinessNoteTag =>
        (TAG_IDS as string[]).includes(tag),
      ),
      ...(row.body ? { body: row.body } : {}),
      // Reported notes aren't shown to the business, so a shown note is never reported.
      reported: false,
    }));
    // By date only; within a day the (random) reference decides, so the order gives away no time.
    return notes.sort(
      (a, b) => b.date.localeCompare(a.date) || a.tipId.localeCompare(b.tipId),
    );
  });
}

/** The person chooses whether the business sees their weekly total (off by default). */
export async function setShareAmounts(
  db: Database,
  userId: string,
  memberId: string,
  share: boolean,
  now: Date = new Date(),
): Promise<MyMembership> {
  await ownMembership(db, userId, memberId);
  return guarded(async () => {
    await db.execute(
      sql`UPDATE business_members SET share_amounts = ${share} WHERE id = ${memberId} AND left_at IS NULL`,
    );
    const rows = await db.execute<{
      business_id: string;
      business_name: string;
      business_slug: string;
      status: string;
      location_id: string;
      location_name: string;
      location_slug: string;
      handle: string;
      shown_name: string;
      show_photo: boolean;
      share_amounts: boolean;
      started_at: Date | string | null;
    }>(sql`
      SELECT b.id AS business_id, b.name AS business_name, b.slug AS business_slug, b.status,
             l.id AS location_id, l.name AS location_name, l.slug AS location_slug,
             p.handle, m.shown_name, m.show_photo, m.share_amounts,
             (SELECT s.started_at FROM business_shifts s
               WHERE s.member_id = m.id AND s.ended_at IS NULL) AS started_at
        FROM business_members m
        JOIN profiles p ON p.id = m.profile_id
        JOIN business_locations l ON l.id = m.location_id
        JOIN businesses b ON b.id = l.business_id
       WHERE m.id = ${memberId}`);
    const row = rows.rows[0];
    if (!row) throw new OperationError('NO_MEMBERSHIP');
    const startedAt = row.started_at ? new Date(row.started_at) : null;
    const shift = onShift(startedAt ? { startedAt, endedAt: null } : null, now);
    return {
      memberId,
      business: {
        id: row.business_id,
        name: row.business_name,
        slug: row.business_slug,
        status: row.status as BusinessStatus,
      },
      location: {
        id: row.location_id,
        name: row.location_name,
        slug: row.location_slug,
      },
      shownName: row.shown_name,
      showPhoto: row.show_photo,
      shareAmounts: row.share_amounts,
      onShift: shift,
      ...(shift && startedAt
        ? { shiftStartedAt: startedAt.toISOString() }
        : {}),
      staffCodePath: `/b/${row.business_slug}/${row.location_slug}/${row.handle}`,
    };
  });
}
