import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import { mailDailyStats, mailMessageEvents, mailMessages } from '../schema.js';
import { recordAudit } from './audit.js';
import { openSecret } from './secret-box.js';
import type { MailSealing } from './mail-queue.js';

export type MailKind =
  | 'sent'
  | 'delivered'
  | 'bounced'
  | 'complained'
  | 'opened'
  | 'clicked'
  | 'failed';

export type MailPeriod =
  | {
      kind:
        | 'today'
        | 'yesterday'
        | 'this_week'
        | 'last_week'
        | 'this_month'
        | 'last_month';
    }
  | { kind: 'range'; from: string; to: string };

interface DayRange {
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
const KIND_EVENT: Record<Exclude<MailKind, 'opened' | 'clicked'>, string> = {
  sent: 'sent',
  delivered: 'delivered',
  bounced: 'hard_bounce',
  complained: 'complaint',
  failed: 'send_failed',
};

/** Whole-day arithmetic on YYYY-MM-DD, which has no time zone to go wrong. */
const dayNumber = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
const dayOf = (number: number) =>
  new Date(number * DAY_MS).toISOString().slice(0, 10);
const addDays = (day: string, days: number) => dayOf(dayNumber(day) + days);

const lagosToday = (now: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);

const mondayOf = (day: string) => {
  const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(day, -weekday);
};
const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const lastMonth = (day: string): DayRange => {
  const to = addDays(monthStart(day), -1);
  return { from: monthStart(to), to };
};

/** The period, and the one before it: a calendar week or month, else the same length earlier. */
export function mailPeriodRanges(
  period: MailPeriod,
  now: Date,
): { range: DayRange; previous: DayRange } {
  const today = lagosToday(now);
  const single = (day: string) => ({
    range: { from: day, to: day },
    previous: { from: addDays(day, -1), to: addDays(day, -1) },
  });
  switch (period.kind) {
    case 'today':
      return single(today);
    case 'yesterday':
      return single(addDays(today, -1));
    case 'this_week': {
      const monday = mondayOf(today);
      return {
        range: { from: monday, to: today },
        previous: { from: addDays(monday, -7), to: addDays(monday, -1) },
      };
    }
    case 'last_week': {
      const monday = addDays(mondayOf(today), -7);
      return {
        range: { from: monday, to: addDays(monday, 6) },
        previous: { from: addDays(monday, -7), to: addDays(monday, -1) },
      };
    }
    case 'this_month':
      return {
        range: { from: monthStart(today), to: today },
        previous: lastMonth(today),
      };
    case 'last_month': {
      const range = lastMonth(today);
      return { range, previous: lastMonth(range.from) };
    }
    case 'range': {
      const length = dayNumber(period.to) - dayNumber(period.from) + 1;
      return {
        range: { from: period.from, to: period.to },
        previous: {
          from: addDays(period.from, -length),
          to: addDays(period.from, -1),
        },
      };
    }
  }
}

/** Lagos is UTC+1 all year, so a Lagos day's bounds are fixed instants. */
const lagosStart = (day: string) => new Date(`${day}T00:00:00+01:00`);
const lagosEnd = (day: string) => lagosStart(addDays(day, 1));

async function statTotals(db: Database, range: DayRange) {
  const rows = await db
    .select({
      kind: mailDailyStats.kind,
      type: mailDailyStats.type,
      provider: mailDailyStats.provider,
      n: sql<number>`sum(${mailDailyStats.count})::int`,
    })
    .from(mailDailyStats)
    .where(
      sql`${mailDailyStats.lagosDate} BETWEEN ${range.from}::date AND ${range.to}::date`,
    )
    .groupBy(mailDailyStats.kind, mailDailyStats.type, mailDailyStats.provider);
  return rows;
}

/** Messages with at least one such event: repeat opens of one email count once. */
async function uniqueMessages(db: Database, kind: string, range: DayRange) {
  const [row] = await db
    .select({
      n: sql<number>`count(DISTINCT ${mailMessageEvents.messageId})::int`,
    })
    .from(mailMessageEvents)
    .where(
      and(
        eq(mailMessageEvents.kind, kind),
        gte(mailMessageEvents.occurredAt, lagosStart(range.from)),
        lt(mailMessageEvents.occurredAt, lagosEnd(range.to)),
      ),
    );
  return row?.n ?? 0;
}

const percent = (count: number, previous: number) =>
  previous === 0 ? null : Math.round(((count - previous) * 100) / previous);

export async function mailPeriodSummary(
  db: Database,
  period: MailPeriod,
  now: Date,
) {
  const { range, previous } = mailPeriodRanges(period, now);
  const [current, before] = await Promise.all([
    statTotals(db, range),
    statTotals(db, previous),
  ]);
  const sum = (rows: typeof current, kind: string) =>
    rows.filter((r) => r.kind === kind).reduce((n, r) => n + r.n, 0);
  const total = (count: number, prior: number) => ({
    count,
    previous: prior,
    changePct: percent(count, prior),
  });
  const totals = Object.fromEntries(
    Object.entries(KIND_EVENT).map(([kind, event]) => [
      kind,
      total(sum(current, event), sum(before, event)),
    ]),
  ) as Record<MailKind, ReturnType<typeof total>>;
  totals.opened = total(
    await uniqueMessages(db, 'opened', range),
    await uniqueMessages(db, 'opened', previous),
  );
  totals.clicked = total(
    await uniqueMessages(db, 'clicked', range),
    await uniqueMessages(db, 'clicked', previous),
  );
  const sent = totals.sent.count;
  const rate = (count: number) => (sent === 0 ? null : count / sent);
  const breakdown = <K extends 'type' | 'provider'>(key: K) => {
    const names = [
      ...new Set(
        [...current, ...before]
          .filter((r) => r.kind === 'sent')
          .map((r) => r[key]),
      ),
    ];
    const of = (rows: typeof current, name: string) =>
      rows
        .filter((r) => r.kind === 'sent' && r[key] === name)
        .reduce((n, r) => n + r.n, 0);
    return names
      .map((name) => ({
        name,
        sent: of(current, name),
        previous: of(before, name),
      }))
      .sort((a, b) => b.sent - a.sent);
  };
  return {
    range,
    previous,
    totals,
    rates: {
      delivery: rate(totals.delivered.count),
      open: rate(totals.opened.count),
      click: rate(totals.clicked.count),
    },
    byType: breakdown('type').map(({ name, ...rest }) => ({
      type: name,
      ...rest,
    })),
    byProvider: breakdown('provider').map(({ name, ...rest }) => ({
      provider: name,
      ...rest,
    })),
  };
}

export interface MailSeriesPoint {
  /** YYYY-MM-DD, or YYYY-MM-DDTHH for a single day shown by the hour. */
  date: string;
  sent: number;
  delivered: number;
  bounced: number;
  opened: number;
  clicked: number;
  failed: number;
  previousSent: number;
}

const SERIES_KINDS: Record<
  string,
  keyof Omit<MailSeriesPoint, 'date' | 'previousSent'>
> = {
  sent: 'sent',
  delivered: 'delivered',
  hard_bounce: 'bounced',
  opened: 'opened',
  clicked: 'clicked',
  send_failed: 'failed',
};

const emptyPoint = (date: string): MailSeriesPoint => ({
  date,
  sent: 0,
  delivered: 0,
  bounced: 0,
  opened: 0,
  clicked: 0,
  failed: 0,
  previousSent: 0,
});

/** One point per day, with the previous period's sends aligned by position; hourly for today. */
export async function mailDailySeries(
  db: Database,
  period: MailPeriod,
  now: Date,
): Promise<MailSeriesPoint[]> {
  const { range, previous } = mailPeriodRanges(period, now);
  if (period.kind === 'today') {
    const rows = await db.execute<{
      hour: string;
      kind: string;
      n: number;
    }>(sql`
      SELECT to_char(${mailMessageEvents.occurredAt} AT TIME ZONE 'Africa/Lagos', 'HH24') AS hour,
             ${mailMessageEvents.kind} AS kind, count(*)::int AS n
        FROM ${mailMessageEvents}
       WHERE ${mailMessageEvents.occurredAt} >= ${lagosStart(range.from).toISOString()}::timestamptz
         AND ${mailMessageEvents.occurredAt} < ${lagosEnd(range.from).toISOString()}::timestamptz
       GROUP BY 1, 2`);
    const points = Array.from({ length: 24 }, (_, hour) =>
      emptyPoint(`${range.from}T${String(hour).padStart(2, '0')}`),
    );
    for (const row of rows.rows) {
      const field = SERIES_KINDS[row.kind];
      const point = points[Number(row.hour)];
      if (field && point) point[field] += row.n;
    }
    return points;
  }
  const read = (r: DayRange) =>
    db
      .select({
        date: sql<string>`${mailDailyStats.lagosDate}::text`,
        kind: mailDailyStats.kind,
        n: sql<number>`sum(${mailDailyStats.count})::int`,
      })
      .from(mailDailyStats)
      .where(
        sql`${mailDailyStats.lagosDate} BETWEEN ${r.from}::date AND ${r.to}::date`,
      )
      .groupBy(mailDailyStats.lagosDate, mailDailyStats.kind);
  const [current, before] = await Promise.all([read(range), read(previous)]);
  const days = dayNumber(range.to) - dayNumber(range.from) + 1;
  const points = Array.from({ length: days }, (_, i) =>
    emptyPoint(addDays(range.from, i)),
  );
  for (const row of current) {
    const field = SERIES_KINDS[row.kind];
    const point = points[dayNumber(row.date) - dayNumber(range.from)];
    if (field && point) point[field] += row.n;
  }
  for (const row of before) {
    const point = points[dayNumber(row.date) - dayNumber(previous.from)];
    if (row.kind === 'sent' && point) point.previousSent += row.n;
  }
  return points;
}

export interface MailListRow {
  id: string;
  createdAt: string;
  type: string;
  category: string;
  toHint: string;
  userId: string | null;
  provider: string | null;
  status: string;
  lastEvent: string | null;
}

/** Every email created in the period, newest first. The cursor is the last row's time and id. */
export async function listMail(
  db: Database,
  filter: {
    period: MailPeriod;
    type?: string;
    status?: string;
    provider?: string;
    userId?: string;
    cursor?: string;
    limit: number;
  },
  now: Date,
): Promise<{ rows: MailListRow[]; nextCursor: string | null }> {
  const { range } = mailPeriodRanges(filter.period, now);
  const [cursorAt, cursorId] = filter.cursor?.split('|') ?? [];
  const after =
    cursorAt && cursorId
      ? sql`(${mailMessages.createdAt}, ${mailMessages.id}) < (${cursorAt}::timestamptz, ${cursorId}::uuid)`
      : undefined;
  const rows = await db
    .select({
      id: mailMessages.id,
      createdAt: mailMessages.createdAt,
      cursorAt: sql<string>`to_char(${mailMessages.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      type: mailMessages.type,
      category: mailMessages.category,
      toHint: mailMessages.toHint,
      userId: mailMessages.userId,
      provider: mailMessages.provider,
      status: mailMessages.status,
      lastEvent: sql<string | null>`(
        SELECT e.kind FROM ${mailMessageEvents} e
         WHERE e.message_id = "mail_messages"."id"
         ORDER BY e.occurred_at DESC, e.created_at DESC, e.id DESC LIMIT 1)`,
    })
    .from(mailMessages)
    .where(
      and(
        gte(mailMessages.createdAt, lagosStart(range.from)),
        lt(mailMessages.createdAt, lagosEnd(range.to)),
        filter.type ? eq(mailMessages.type, filter.type) : undefined,
        filter.status ? eq(mailMessages.status, filter.status) : undefined,
        filter.provider
          ? eq(mailMessages.provider, filter.provider)
          : undefined,
        filter.userId ? eq(mailMessages.userId, filter.userId) : undefined,
        after,
      ),
    )
    .orderBy(desc(mailMessages.createdAt), desc(mailMessages.id))
    .limit(filter.limit + 1);
  const page = rows.slice(0, filter.limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      type: row.type,
      category: row.category,
      toHint: row.toHint,
      userId: row.userId,
      provider: row.provider,
      status: row.status,
      lastEvent: row.lastEvent,
    })),
    nextCursor:
      rows.length > filter.limit && last ? `${last.cursorAt}|${last.id}` : null,
  };
}

export async function mailTimeline(db: Database, messageId: string) {
  const rows = await db
    .select({
      kind: mailMessageEvents.kind,
      provider: mailMessageEvents.provider,
      linkKey: mailMessageEvents.linkKey,
      occurredAt: mailMessageEvents.occurredAt,
    })
    .from(mailMessageEvents)
    .where(eq(mailMessageEvents.messageId, messageId))
    .orderBy(mailMessageEvents.occurredAt, mailMessageEvents.receivedAt);
  return rows.map((row) => ({
    ...row,
    occurredAt: row.occurredAt.toISOString(),
  }));
}

/** The email as sent (personal links already redacted). Security email has no snapshot at all. */
export async function openMailSnapshot(
  db: Database,
  sealing: MailSealing,
  input: { messageId: string; staffUserId: string },
): Promise<
  | { status: 'ok'; subject: string; html: string; text: string }
  | { status: 'withheld' }
  | { status: 'not_found' }
> {
  const [row] = await db
    .select({
      category: mailMessages.category,
      rendered: mailMessages.renderedSealed,
    })
    .from(mailMessages)
    .where(eq(mailMessages.id, input.messageId));
  if (!row) return { status: 'not_found' };
  await recordAudit(db, {
    staffUserId: input.staffUserId,
    action: 'email.viewed',
    permission: 'issues.view',
    subjectType: 'mail_message',
    subjectId: input.messageId,
  });
  if (row.category === 'security' || !row.rendered)
    return { status: 'withheld' };
  const snapshot = JSON.parse(openSecret(sealing.key, row.rendered)) as {
    subject: string;
    html: string;
    text: string;
  };
  return {
    status: 'ok',
    subject: snapshot.subject,
    html: snapshot.html,
    text: snapshot.text,
  };
}

/** The full address, for support, with a reason. Gone once the sealed address is wiped. */
export async function revealMailRecipient(
  db: Database,
  sealing: MailSealing,
  input: { messageId: string; staffUserId: string; reason: string },
): Promise<{ address: string | null }> {
  const [row] = await db
    .select({ to: mailMessages.toSealed })
    .from(mailMessages)
    .where(eq(mailMessages.id, input.messageId));
  await recordAudit(db, {
    staffUserId: input.staffUserId,
    action: 'email.recipient_revealed',
    permission: 'private.view',
    subjectType: 'mail_message',
    subjectId: input.messageId,
    reason: input.reason,
  });
  return { address: row?.to ? openSecret(sealing.key, row.to) : null };
}

/** Recomputes the day totals from the events (a final failure counts once per email). */
export async function rebuildMailDailyStats(
  db: Database,
  from: string,
  to: string,
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx
      .delete(mailDailyStats)
      .where(
        sql`${mailDailyStats.lagosDate} BETWEEN ${from}::date AND ${to}::date`,
      );
    const result = await tx.execute(sql`
      INSERT INTO mail_daily_stats (lagos_date, type, category, provider, kind, count)
      SELECT (e.occurred_at AT TIME ZONE 'Africa/Lagos')::date, m.type, m.category,
             coalesce(e.provider, ''), e.kind, count(*)::int
        FROM mail_message_events e JOIN mail_messages m ON m.id = e.message_id
       WHERE e.occurred_at >= ${lagosStart(from).toISOString()}::timestamptz
         AND e.occurred_at < ${lagosEnd(to).toISOString()}::timestamptz
         AND (e.kind <> 'send_failed' OR (m.status = 'failed' AND e.occurred_at = m.final_at))
       GROUP BY 1, 2, 3, 4, 5`);
    return result.rowCount ?? 0;
  });
}
