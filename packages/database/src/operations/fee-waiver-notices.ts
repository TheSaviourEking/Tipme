import { FEE_WAIVER_NOTICE_COPY } from '@tipme/contracts';
import {
  untilWords,
  untilWordsWithYear,
  type FeeWaiverFee,
  type FeeWaiverKind,
} from '@tipme/domain';
import { eq, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  feeWaiverAccountNotices,
  feeWaiverNotices,
  notifications,
  profiles,
  type IssueSubject,
} from '../schema.js';
import { businessManagerUsers } from './business-ops.js';
import {
  feeWaiversPaused,
  tipWaiversPausedNow,
  type FeeWaiverPauseSignal,
} from './fee-waiver-pause.js';
import { feeWaiverFor } from './fee-waivers.js';
import { newId } from './ids.js';
import { markResolved, openIssue } from './issues.js';
import type { MoneyOwner } from './owner.js';

/*
 * Fee waivers (spec 2026-11-23 §5, §6; W13, W14; rulings R20 reversed, R22): what the `fees.waivers`
 * worker job tells people, each thing once however often it runs.
 *
 * - An ACCOUNT waiver (a `tipme` account rule) starting sends that account an in-app notice: the
 *   page's owner, or a business's owners. A tip waiver starting while tip waivers are paused is told
 *   once the pause lifts, so it never promises a cover new tips won't get.
 * - An account is told its fee cover ENDED when TipMe stops paying that fee for it: never while TipMe
 *   still pays it (a renewal, its own waiver, or a kind-wide one). That covers its own waiver ending,
 *   and a kind-wide waiver ending for each account that used it (R22: at least one tip or withdrawal
 *   waived under it). However many rules end together for one account and fee, it gets one notice:
 *   `fee_waiver_notices (rule_id, kind)` and `fee_waiver_account_notices` record each, under a lock
 *   per account and fee. A kind-wide waiver's start tells nobody (§6).
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
  /** Ended notices sent by this run: one per account and fee, whichever rules ended. */
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

/** `w` is over at `now`: it ended, or a newer row of its key replaced it. */
const over = (now: Date): SQL =>
  sql`((w.ends_at IS NOT NULL AND w.ends_at <= ${at(now)}) OR ${superseded(now)})`;

/** An account by its columns (exactly one is not null), as SQL expressions. */
type Who = { profile: SQL; business: SQL };

/**
 * The payer of the account's own rule in force at `now` for `fee`, else NULL: the SQL twin of the
 * account half of `resolveFeeWaiver`. Only a filter: the notice itself asks `feeWaiverFor`.
 */
const ownPayerNow = (who: Who, fee: SQL, now: Date): SQL => sql`(
  SELECT CASE WHEN a.ends_at IS NULL OR a.ends_at > ${at(now)} THEN a.payer END
    FROM fee_waivers a
   WHERE a.scope = 'account' AND a.fee = ${fee}
     AND (a.profile_id = ${who.profile} OR a.business_id = ${who.business})
     AND a.starts_at <= ${at(now)}
   ORDER BY a.starts_at DESC, a.created_at DESC LIMIT 1)`;

/** A kind-wide TipMe-pays rule is its key's row in force at `now`. */
const kindPaysNow = (kind: SQL, fee: SQL, now: Date): SQL => sql`coalesce((
  SELECT k.payer = 'tipme' AND (k.ends_at IS NULL OR k.ends_at > ${at(now)})
    FROM fee_waivers k
   WHERE k.scope = 'kind' AND k.kind = ${kind} AND k.fee = ${fee}
     AND k.starts_at <= ${at(now)}
   ORDER BY k.starts_at DESC, k.created_at DESC LIMIT 1), false)`;

/** TipMe pays `fee` for the account at `now` (§4): its own rule, else its kind's. */
const tipmePaysNow = (who: Who, kind: SQL, fee: SQL, now: Date): SQL =>
  sql`(CASE coalesce(${ownPayerNow(who, fee, now)}, 'inherit')
         WHEN 'tipme' THEN true WHEN 'account' THEN false
         ELSE ${kindPaysNow(kind, fee, now)} END)`;

/** The account used rule `rule`'s cover: a SUCCEEDED tip or a withdrawal not FAILED under it (R22). */
const usedCover = (rule: SQL, who: Who): SQL => sql`(EXISTS (
    SELECT 1 FROM tip_quotes q
      JOIN payment_intents i ON i.quote_id = q.id
      JOIN tips t ON t.intent_id = i.id
     WHERE q.fee_waiver_id = ${rule} AND q.profile_id = ${who.profile}
       AND t.status = 'SUCCEEDED')
  OR EXISTS (
    SELECT 1 FROM payouts p
     WHERE p.fee_waiver_id = ${rule} AND p.status <> 'FAILED'
       AND (p.profile_id = ${who.profile} OR p.business_id = ${who.business})))`;

const whoOfOwner = (owner: MoneyOwner): Who =>
  'businessId' in owner
    ? { profile: sql`NULL::uuid`, business: sql`${owner.businessId}::uuid` }
    : { profile: sql`${owner.profileId}::uuid`, business: sql`NULL::uuid` };

const ownerOf = (row: {
  profile_id: string | null;
  business_id: string | null;
}): MoneyOwner =>
  row.business_id !== null
    ? { businessId: row.business_id }
    : { profileId: row.profile_id! };

/** Who an account's notice goes to, and the business's name for a business. */
async function recipientsOf(
  tx: Tx,
  owner: MoneyOwner,
): Promise<{ userIds: string[]; business: string | null }> {
  if ('businessId' in owner) {
    const [business] = await tx
      .select({ name: businesses.name })
      .from(businesses)
      .where(eq(businesses.id, owner.businessId));
    return {
      userIds: await businessManagerUsers(tx, owner.businessId, {
        owners: true,
      }),
      business: business?.name ?? null,
    };
  }
  const [page] = await tx
    .select({ userId: profiles.userId })
    .from(profiles)
    .where(eq(profiles.id, owner.profileId));
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
  owner: MoneyOwner,
  notice: {
    kind: 'fee_waiver_started' | 'fee_waiver_ended';
    title: (business: string | null) => string;
    body: string;
  },
  now: Date,
): Promise<void> {
  const { userIds, business } = await recipientsOf(tx, owner);
  for (const userId of userIds)
    await tx.insert(notifications).values({
      id: newId(),
      userId,
      kind: notice.kind,
      businessId: 'businessId' in owner ? owner.businessId : null,
      title: notice.title(business),
      body: notice.body,
      createdAt: now,
    });
}

const ACCOUNT_RULE = sql`w.scope = 'account' AND w.payer = 'tipme'`;
const COLUMNS = sql`w.id, w.scope, w.kind, w.fee, w.profile_id, w.business_id, w.ends_at`;

/**
 * Account waivers in force whose start has not been told yet: told now (W13). While tip waivers are
 * paused, a tip waiver waits unclaimed (new tips are priced normally) and is told on the first run
 * after the pause lifts; withdrawal waivers are never paused (W6).
 */
async function tellStarted(
  db: Database,
  activeProvider: string,
  now: Date,
): Promise<number> {
  const paused = await tipWaiversPausedNow(db, activeProvider);
  const { rows } = await db.execute<RuleRow>(sql`
    SELECT ${COLUMNS} FROM fee_waivers w
     WHERE ${ACCOUNT_RULE} AND ${inForce(now)}
       ${paused ? sql`AND w.fee <> 'tip'` : sql``}
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
          ownerOf(row),
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
 * Tells one account that TipMe stopped paying `fee`, once (R22). Under a lock per account and fee,
 * so overlapping runs and the two passes below send one notice: if TipMe still pays the fee it
 * claims nothing (it is told when that cover stops); else it records, together, every one of the
 * account's own waivers for that fee told as started and now over, and every kind-wide waiver for it
 * that is over and whose cover the account used, and sends one notice if any was not yet recorded.
 */
async function tellAccountEnded(
  db: Database,
  input: { owner: MoneyOwner; kind: FeeWaiverKind; fee: FeeWaiverFee },
  now: Date,
): Promise<boolean> {
  const { owner, kind, fee } = input;
  const accountId = 'businessId' in owner ? owner.businessId : owner.profileId;
  const who = whoOfOwner(owner);
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`fee_waiver_notice:${accountId}:${fee}`}))`,
    );
    if ((await feeWaiverFor(tx, { owner, fee, now })).payer === 'tipme')
      return false;
    const { rows: own } = await tx.execute<{ rule_id: string }>(sql`
      INSERT INTO fee_waiver_notices (rule_id, kind, created_at)
      SELECT w.id, 'ended', ${at(now)} FROM fee_waivers w
       WHERE ${ACCOUNT_RULE} AND w.fee = ${fee}
         AND (w.profile_id = ${who.profile} OR w.business_id = ${who.business})
         AND EXISTS (SELECT 1 FROM fee_waiver_notices s
                      WHERE s.rule_id = w.id AND s.kind = 'started')
         AND ${over(now)}
      ON CONFLICT DO NOTHING
      RETURNING rule_id`);
    const { rows: kindRules } = await tx.execute<{ id: string }>(sql`
      SELECT w.id FROM fee_waivers w
       WHERE w.scope = 'kind' AND w.payer = 'tipme'
         AND w.kind = ${kind} AND w.fee = ${fee}
         AND ${over(now)}
         AND ${usedCover(sql`w.id`, who)}
         AND NOT EXISTS (SELECT 1 FROM fee_waiver_account_notices n
                          WHERE n.rule_id = w.id AND n.kind = 'ended'
                            AND (n.profile_id = ${who.profile} OR n.business_id = ${who.business}))`);
    let kindClaimed = 0;
    for (const rule of kindRules) {
      const inserted = await tx
        .insert(feeWaiverAccountNotices)
        .values({
          id: newId(),
          ruleId: rule.id,
          profileId: 'profileId' in owner ? owner.profileId : null,
          businessId: 'businessId' in owner ? owner.businessId : null,
          kind: 'ended',
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: feeWaiverAccountNotices.id });
      kindClaimed += inserted.length;
    }
    if (own.length + kindClaimed === 0) return false;
    await notify(
      tx,
      owner,
      {
        kind: 'fee_waiver_ended',
        title: (business) =>
          business === null
            ? FEE_WAIVER_NOTICE_COPY.endedTitle(fee)
            : FEE_WAIVER_NOTICE_COPY.endedTitleFor(business, fee),
        body: FEE_WAIVER_NOTICE_COPY.ended(fee),
      },
      now,
    );
    return true;
  });
}

/**
 * Account waivers told as started that are over (they ended, or were replaced), for accounts TipMe
 * no longer pays that fee for. One still covered (renewed, or under a kind-wide waiver) is left out
 * here, so held rows never fill the batch, and is told once its cover really stops.
 */
async function tellEnded(db: Database, now: Date): Promise<number> {
  const { rows } = await db.execute<RuleRow>(sql`
    SELECT ${COLUMNS} FROM fee_waivers w
     WHERE ${ACCOUNT_RULE}
       AND EXISTS (SELECT 1 FROM fee_waiver_notices s
                    WHERE s.rule_id = w.id AND s.kind = 'started')
       AND NOT EXISTS (SELECT 1 FROM fee_waiver_notices e
                        WHERE e.rule_id = w.id AND e.kind = 'ended')
       AND ${over(now)}
       AND NOT ${tipmePaysNow({ profile: sql`w.profile_id`, business: sql`w.business_id` }, sql`w.kind`, sql`w.fee`, now)}
     ORDER BY w.id
     LIMIT ${BATCH}`);
  let told = 0;
  for (const row of rows)
    if (
      await tellAccountEnded(
        db,
        { owner: ownerOf(row), kind: row.kind, fee: row.fee },
        now,
      )
    )
      told += 1;
  return told;
}

type UsedAccount = {
  account_id: string;
  profile_id: string | null;
  business_id: string | null;
};

/** Pages of accounts one kind-wide waiver's end may reach per run: the rest go on next run. */
const KIND_PAGES_PER_RUN = 5;

/**
 * Kind-wide TipMe-pays waivers that are over while their key no longer makes TipMe pay (a renewal
 * by a newer TipMe-pays row ends quietly, and is told when the renewal ends): each account that used
 * the cover and now follows the kind-wide rule again is told (R22). An account under its own waiver
 * is told when that ends (tellEnded); one opted out (its own `account` row) is not told. Pages by
 * account id; once a page comes back short every account is seen to, and the rule's
 * `fee_waiver_notices (rule_id, 'ended')` row says so, so it is not read again.
 */
async function tellKindEnded(db: Database, now: Date): Promise<number> {
  const { rows: rules } = await db.execute<{
    id: string;
    kind: FeeWaiverKind;
    fee: FeeWaiverFee;
  }>(sql`
    SELECT w.id, w.kind, w.fee FROM fee_waivers w
     WHERE w.scope = 'kind' AND w.payer = 'tipme' AND ${over(now)}
       AND NOT ${kindPaysNow(sql`w.kind`, sql`w.fee`, now)}
       AND NOT EXISTS (SELECT 1 FROM fee_waiver_notices e
                        WHERE e.rule_id = w.id AND e.kind = 'ended')
     ORDER BY w.id
     LIMIT ${BATCH}`);
  let told = 0;
  for (const rule of rules) {
    let after: string | null = null;
    let done = false;
    for (let page = 0; page < KIND_PAGES_PER_RUN && !done; page += 1) {
      const used = { profile: sql`u.profile_id`, business: sql`u.business_id` };
      const cursor: SQL =
        after === null ? sql`true` : sql`u.account_id > ${after}::uuid`;
      const { rows: accounts }: { rows: UsedAccount[] } =
        await db.execute<UsedAccount>(sql`
        SELECT u.account_id, u.profile_id, u.business_id FROM (
          SELECT q.profile_id AS account_id, q.profile_id, NULL::uuid AS business_id
            FROM tip_quotes q
            JOIN payment_intents i ON i.quote_id = q.id
            JOIN tips t ON t.intent_id = i.id
           WHERE q.fee_waiver_id = ${rule.id} AND q.profile_id IS NOT NULL
             AND t.status = 'SUCCEEDED'
          UNION
          SELECT coalesce(p.profile_id, p.business_id), p.profile_id, p.business_id
            FROM payouts p
           WHERE p.fee_waiver_id = ${rule.id} AND p.status <> 'FAILED'
        ) u
         WHERE ${cursor}
           AND NOT EXISTS (SELECT 1 FROM fee_waiver_account_notices n
                            WHERE n.rule_id = ${rule.id} AND n.kind = 'ended'
                              AND (n.profile_id = u.profile_id OR n.business_id = u.business_id))
           AND coalesce(${ownPayerNow(used, sql`${rule.fee}`, now)}, 'inherit') = 'inherit'
         ORDER BY u.account_id
         LIMIT ${BATCH}`);
      for (const account of accounts)
        if (
          await tellAccountEnded(
            db,
            { owner: ownerOf(account), kind: rule.kind, fee: rule.fee },
            now,
          )
        )
          told += 1;
      after = accounts.at(-1)?.account_id ?? after;
      done = accounts.length < BATCH;
    }
    if (done)
      await db
        .insert(feeWaiverNotices)
        .values({ ruleId: rule.id, kind: 'ended', createdAt: now })
        .onConflictDoNothing();
  }
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
      note: `TipMe pays the ${row.fee} fee for ${whoOf(row)} ${untilWordsWithYear(asDate(row.ends_at!))} (rule ${row.id}). Renew it before then if it should go on.`,
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
 * One run of the `fees.waivers` job (W13, W14, R22): ends before starts (account waivers, then
 * kind-wide ones), so a renewed waiver reads in order, then the staff day-before issues, then the
 * pause alert. Idempotent through `fee_waiver_notices`, `fee_waiver_account_notices` and the issues'
 * dedupe keys, so a run repeated or overlapping tells nothing twice.
 */
export async function runFeeWaiverNotices(
  db: Database,
  input: { activeProvider: string; now: Date },
): Promise<FeeWaiverNoticesResult> {
  const { now } = input;
  const ended = (await tellEnded(db, now)) + (await tellKindEnded(db, now));
  const started = await tellStarted(db, input.activeProvider, now);
  const endingSoon = await flagEndingSoon(db, now);
  const paused = await alertPause(db, input.activeProvider, now);
  return { endingSoon, started, ended, paused };
}
