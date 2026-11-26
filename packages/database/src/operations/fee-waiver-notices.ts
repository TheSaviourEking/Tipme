import { FEE_WAIVER_NOTICE_COPY } from '@tipme/contracts';
import {
  untilWords,
  type FeeWaiverFee,
  type FeeWaiverKind,
} from '@tipme/domain';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  feeWaiverNotices,
  notifications,
  profiles,
  type IssueSubject,
} from '../schema.js';
import { businessManagerUsers } from './business-ops.js';
import {
  feeWaiversPaused,
  type FeeWaiverPauseSignal,
} from './fee-waiver-pause.js';
import { feeWaiverFor } from './fee-waivers.js';
import { newId } from './ids.js';
import { markResolved, openIssue } from './issues.js';
import type { MoneyOwner } from './owner.js';

/*
 * Fee waivers (spec 2026-11-23 §5, §6; W13, W14): what the `fees.waivers` worker job tells people,
 * each thing once however often it runs.
 *
 * - An ACCOUNT waiver (a `tipme` account rule) starting or ending sends that account an in-app
 *   notice: the page's owner, or a business's owners. `fee_waiver_notices (rule_id, kind)` makes
 *   each one once. A kind-wide waiver sends none (§6).
 * - Staff get a `fee_waiver_ending` issue the day before any waiver ends, once by its dedupe key
 *   `fee_waiver_ending.<ruleId>` (R6: there is no notices row for it).
 * - While tip waivers are paused (low balance) and some tip waiver is in force, one
 *   `fee_waivers_paused` issue per spell, keyed by the spell's first reading; it closes itself once
 *   the balance recovers.
 */

export interface FeeWaiverNoticesResult {
  /** `fee_waiver_ending` issues opened by this run. */
  endingSoon: number;
  /** Account waivers whose start was told by this run. */
  started: number;
  /** Account waivers whose end was told by this run. */
  ended: number;
  /**
   * The pause alert: `opened` when this run opened the spell's issue (the only time to post the
   * webhook), `open` when it already existed, `resolved` when this run closed one, else `none`.
   */
  paused: 'opened' | 'open' | 'resolved' | 'none';
}

/** Rules handled per kind of notice per run: the rest wait for the next run, 15 minutes later. */
const BATCH = 200;
const DAY_MS = 24 * 3_600_000;

type RuleRow = {
  id: string;
  kind: FeeWaiverKind;
  fee: FeeWaiverFee;
  profile_id: string | null;
  business_id: string | null;
  scope: 'kind' | 'account';
  ends_at: Date | string | null;
};

const at = (d: Date) => sql`${d.toISOString()}::timestamptz`;
const asDate = (v: Date | string) => (v instanceof Date ? v : new Date(v));

/** A newer row of `w`'s key has started by `now`: `w` is no longer its key's row in force (W2). */
const superseded = (now: Date): SQL => sql`EXISTS (
  SELECT 1 FROM fee_waivers n
   WHERE n.scope = w.scope AND n.kind = w.kind AND n.fee = w.fee
     AND n.profile_id IS NOT DISTINCT FROM w.profile_id
     AND n.business_id IS NOT DISTINCT FROM w.business_id
     AND n.starts_at <= ${at(now)}
     AND (n.starts_at, n.created_at) > (w.starts_at, w.created_at))`;

/** `w` is its key's row in force at `now`: started, not ended, and not replaced (W2). */
const inForce = (now: Date): SQL => sql`w.starts_at <= ${at(now)}
  AND (w.ends_at IS NULL OR w.ends_at > ${at(now)}) AND NOT ${superseded(now)}`;

const ownerOf = (row: RuleRow): MoneyOwner =>
  row.business_id !== null
    ? { businessId: row.business_id }
    : { profileId: row.profile_id! };

/** Who an account's notice goes to, and the business's name for a business. */
async function recipientsOf(
  tx: Tx,
  row: RuleRow,
): Promise<{ userIds: string[]; business: string | null }> {
  if (row.business_id !== null) {
    const [business] = await tx
      .select({ name: businesses.name })
      .from(businesses)
      .where(eq(businesses.id, row.business_id));
    return {
      userIds: await businessManagerUsers(tx, row.business_id, {
        owners: true,
      }),
      business: business?.name ?? null,
    };
  }
  const [page] = await tx
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.id, row.profile_id!));
  return { userIds: page?.userId ? [page.userId] : [], business: null };
}

/** Records the notice once; false when another run already did. */
async function claim(
  tx: Tx,
  ruleId: string,
  kind: 'started' | 'ended',
  now: Date,
): Promise<boolean> {
  const inserted = await tx
    .insert(feeWaiverNotices)
    .values({ ruleId, kind, createdAt: now })
    .onConflictDoNothing()
    .returning({ ruleId: feeWaiverNotices.ruleId });
  return inserted.length > 0;
}

async function notify(
  tx: Tx,
  row: RuleRow,
  notice: {
    kind: 'fee_waiver_started' | 'fee_waiver_ended';
    title: (business: string | null) => string;
    body: string;
  },
  now: Date,
): Promise<void> {
  const { userIds, business } = await recipientsOf(tx, row);
  for (const userId of userIds)
    await tx.insert(notifications).values({
      id: newId(),
      userId,
      kind: notice.kind,
      businessId: row.business_id,
      title: notice.title(business),
      body: notice.body,
      createdAt: now,
    });
}

const ACCOUNT_RULE = sql`w.scope = 'account' AND w.payer = 'tipme'`;
const COLUMNS = sql`w.id, w.scope, w.kind, w.fee, w.profile_id, w.business_id, w.ends_at`;

/** Account waivers in force whose start has not been told yet: told now (W13). */
async function tellStarted(db: Database, now: Date): Promise<number> {
  const { rows } = await db.execute<RuleRow>(sql`
    SELECT ${COLUMNS} FROM fee_waivers w
     WHERE ${ACCOUNT_RULE} AND ${inForce(now)}
       AND NOT EXISTS (SELECT 1 FROM fee_waiver_notices s
                        WHERE s.rule_id = w.id AND s.kind = 'started')
     ORDER BY w.starts_at, w.id
     LIMIT ${BATCH}`);
  let told = 0;
  for (const row of rows)
    if (
      await db.transaction(async (tx) => {
        if (!(await claim(tx, row.id, 'started', now))) return false;
        const until =
          row.ends_at === null ? null : untilWords(asDate(row.ends_at), now);
        await notify(
          tx,
          row,
          {
            kind: 'fee_waiver_started',
            title: (business) =>
              business === null
                ? FEE_WAIVER_NOTICE_COPY.startedTitle
                : FEE_WAIVER_NOTICE_COPY.startedTitleFor(business),
            body: FEE_WAIVER_NOTICE_COPY.started(row.fee, until),
          },
          now,
        );
        return true;
      })
    )
      told += 1;
  return told;
}

/**
 * Account waivers told as started that are no longer their key's row in force (they ended, or were
 * replaced): their end is recorded once. It is told only when TipMe no longer pays that fee for the
 * account, so "Normal fees apply from now" is true: a waiver renewed by a newer TipMe-pays row (its
 * new start is told instead), or one ended while a kind-wide waiver still covers the account, ends
 * quietly.
 */
async function tellEnded(db: Database, now: Date): Promise<number> {
  const { rows } = await db.execute<RuleRow>(sql`
    SELECT ${COLUMNS} FROM fee_waivers w
     WHERE ${ACCOUNT_RULE}
       AND EXISTS (SELECT 1 FROM fee_waiver_notices s
                    WHERE s.rule_id = w.id AND s.kind = 'started')
       AND NOT EXISTS (SELECT 1 FROM fee_waiver_notices e
                        WHERE e.rule_id = w.id AND e.kind = 'ended')
       AND ((w.ends_at IS NOT NULL AND w.ends_at <= ${at(now)}) OR ${superseded(now)})
     ORDER BY w.id
     LIMIT ${BATCH}`);
  let told = 0;
  for (const row of rows)
    if (
      await db.transaction(async (tx) => {
        if (!(await claim(tx, row.id, 'ended', now))) return false;
        const still = await feeWaiverFor(tx, {
          owner: ownerOf(row),
          fee: row.fee,
          now,
        });
        if (still.payer === 'tipme') return false;
        await notify(
          tx,
          row,
          {
            kind: 'fee_waiver_ended',
            title: (business) =>
              business === null
                ? FEE_WAIVER_NOTICE_COPY.endedTitle
                : FEE_WAIVER_NOTICE_COPY.endedTitleFor(business),
            body: FEE_WAIVER_NOTICE_COPY.ended,
          },
          now,
        );
        return true;
      })
    )
      told += 1;
  return told;
}

const ENDING_PREFIX = 'fee_waiver_ending.';

const whoOf = (row: RuleRow): string =>
  row.scope === 'kind'
    ? row.kind === 'giving'
      ? 'every Giving organisation'
      : `every ${row.kind} account`
    : row.business_id !== null
      ? 'this business'
      : 'this page';

/**
 * Staff are told the day before a waiver ends (§6, W13): one issue per rule, kind-wide ones too, once
 * its end is within 24 hours. An end with no waiver (R19: a kind's `account` row) is not one. Each
 * closes itself once its rule has ended or been replaced.
 */
async function flagEndingSoon(db: Database, now: Date): Promise<number> {
  const { rows } = await db.execute<RuleRow>(sql`
    SELECT ${COLUMNS} FROM fee_waivers w
     WHERE w.payer = 'tipme' AND ${inForce(now)}
       AND w.ends_at <= ${at(new Date(now.getTime() + DAY_MS))}
       AND NOT EXISTS (SELECT 1 FROM issues i
                        WHERE i.dedupe_key = ${ENDING_PREFIX} || w.id::text)
     ORDER BY w.ends_at, w.id
     LIMIT ${BATCH}`);
  let opened = 0;
  for (const row of rows) {
    const subject: IssueSubject =
      row.business_id !== null
        ? { businessId: row.business_id }
        : row.profile_id !== null
          ? { profileId: row.profile_id }
          : {};
    const { opened: isNew } = await openIssue(db, {
      dedupeKey: `${ENDING_PREFIX}${row.id}`,
      kind: 'fee_waiver_ending',
      subject,
      now,
      note: `TipMe pays the ${row.fee} fee for ${whoOf(row)} until ${asDate(row.ends_at!).toISOString()} (rule ${row.id}). Renew it before then if it should go on.`,
    });
    if (isNew) opened += 1;
  }
  const { rows: over } = await db.execute<{ id: string }>(sql`
    SELECT i.id FROM issues i
      JOIN fee_waivers w ON i.dedupe_key = ${ENDING_PREFIX} || w.id::text
     WHERE i.kind = 'fee_waiver_ending' AND i.status = 'open'
       AND (w.ends_at <= ${at(now)} OR ${superseded(now)})
     LIMIT ${BATCH}`);
  for (const issue of over)
    await db.transaction((tx) =>
      markResolved(tx, {
        issueId: issue.id,
        resolvedBy: 'system',
        staffUserId: null,
        reason: 'The fee waiver has ended or was replaced.',
        now,
      }),
    );
  return opened;
}

const PAUSED_PREFIX = 'fee_waivers_paused.';

const SIGNAL_WORDS: Record<FeeWaiverPauseSignal, string> = {
  payment_reserve_low: 'the payments reserve reading is low',
  collect_reserve_critical:
    'the You collect reserve reading is at or below its critical level',
};

/** Some tip rule with `payer = 'tipme'` is its key's row in force (W14). */
async function tipWaiverInForce(db: Database, now: Date): Promise<boolean> {
  const { rows } = await db.execute<{ one: number }>(sql`
    SELECT 1 AS one FROM fee_waivers w
     WHERE w.fee = 'tip' AND w.payer = 'tipme' AND ${inForce(now)}
     LIMIT 1`);
  return rows.length > 0;
}

/**
 * The pause alert (W14). One issue per spell, keyed by the spell's first signalling reading, so a run
 * every 15 minutes during one spell finds it already there. An unknown reading neither starts nor
 * ends a spell (R11, in feeWaiversPaused). Open issues of a spell that is over close themselves,
 * including one whose recovery fell between two runs.
 */
async function alertPause(
  db: Database,
  activeProvider: string,
  now: Date,
): Promise<FeeWaiverNoticesResult['paused']> {
  const pause = await feeWaiversPaused(db, { activeProvider });
  const current =
    pause.paused && pause.spellStartReadingId !== null
      ? `${PAUSED_PREFIX}${pause.spellStartReadingId}`
      : null;
  const { rows: over } = await db.execute<{ id: string }>(sql`
    SELECT id FROM issues
     WHERE kind = 'fee_waivers_paused' AND status = 'open'
       AND dedupe_key IS DISTINCT FROM ${current}`);
  let resolved = 0;
  for (const issue of over)
    if (
      await db.transaction((tx) =>
        markResolved(tx, {
          issueId: issue.id,
          resolvedBy: 'system',
          staffUserId: null,
          reason: 'TipMe’s balance reads above its levels again.',
          now,
        }),
      )
    )
      resolved += 1;
  if (current === null || !(await tipWaiverInForce(db, now)))
    return resolved > 0 ? 'resolved' : 'none';
  const reasons = pause.signals.map((s) => SIGNAL_WORDS[s]).join(', and ');
  const { opened } = await openIssue(db, {
    dedupeKey: current,
    kind: 'fee_waivers_paused',
    subject: {},
    now,
    note: `For ${activeProvider}, ${reasons}. New tip quotes ignore tip fee waivers and price normally until it recovers; quotes already shown keep their terms. Top up TipMe’s balance there. This closes itself once it recovers.`,
  });
  return opened ? 'opened' : 'open';
}

/**
 * One run of the `fees.waivers` job (W13, W14): ends before starts, so a renewed waiver reads in
 * order, then the staff day-before issues, then the pause alert. Idempotent through
 * `fee_waiver_notices` and the issues' dedupe keys, so a run repeated or overlapping tells nothing
 * twice.
 */
export async function runFeeWaiverNotices(
  db: Database,
  input: { activeProvider: string; now: Date },
): Promise<FeeWaiverNoticesResult> {
  const { now } = input;
  const ended = await tellEnded(db, now);
  const started = await tellStarted(db, now);
  const endingSoon = await flagEndingSoon(db, now);
  const paused = await alertPause(db, input.activeProvider, now);
  return { endingSoon, started, ended, paused };
}
