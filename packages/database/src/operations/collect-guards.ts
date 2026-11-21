import { createHash } from 'node:crypto';
import { lagosDayStart } from '@tipme/domain';
import { sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { notifications, profiles, tipQuotes } from '../schema.js';
import { heldParts, refundHeldSql } from './balance.js';
import { collectSettingsInForce } from './collect-settings.js';
import type { CollectionMode } from './collection-mode.js';
import { guarded, OperationError } from './errors.js';
import { enqueueMail, type MailSealing } from './mail-queue.js';

/*
 * You collect's guards (plan Task 12; spec §2.1, §8, §9, §10; ADR-0016, PROPOSED). Money TipMe holds
 * for a recipient who hasn't added bank details is capped: once `cap_minor` is held, or `cap_days`
 * have passed since the first waiting tip, whichever first, their page takes no new tips until they
 * are verified (Task 13 sets `collect_verified_at`). They are reminded on the reminder days. A
 * collect recipient's first withdrawal is capped, and while their account is young each Lagos day's
 * withdrawals are limited. Every number is the admin setting in force, read when used. A direct
 * recipient is never touched by any of it.
 */

const DAY_MS = 86_400_000;

/** A share whose money TipMe still holds: not yet paid to the recipient, nor cancelled. */
const HELD_SHARE = sql.raw(`('waiting', 'ready', 'sent', 'unknown', 'review')`);

export interface CollectStatusResult {
  mode: CollectionMode;
  /** The name and bank account were verified (`collect_verified_at`, Task 13). */
  verified: boolean;
  /** What TipMe holds for them on its own account now (their `held_for_recipients`). */
  heldMinor: bigint;
  /** Held while they have no verified bank details: "Kept for you until you add your bank details". */
  keptMinor: bigint;
  /** Held once verified, its transfers still to arrive: "On its way to you". */
  onItsWayMinor: bigint;
  /** RM7: held while a refund of one of their tips is settled (neither of the two above). */
  refundHeldMinor: bigint;
  /** When the oldest tip whose share TipMe still holds settled. */
  firstWaitingAt: Date | null;
  /** The page takes no new tips (holding cap reached, not verified). */
  paused: boolean;
  pausedReason: 'amount' | 'days' | null;
  /** When the days part of the cap is reached, while unverified with money waiting. */
  pauseOn: Date | null;
  /** The most their next withdrawal may be, while it is their first since verification. */
  firstWithdrawalCapMinor: bigint | null;
  /** Their limit per Lagos day for the first days after verification (or until it); else null. */
  dailyLimitMinor: bigint | null;
}

interface Facts {
  mode: CollectionMode;
  verifiedAt: Date | null;
  heldMinor: bigint;
  refundHeldMinor: bigint;
  firstWaitingAt: Date | null;
  /** Withdrawals asked for and not failed, since verification (all of them before it). */
  withdrawals: number;
}

const msOf = (text: string | null) => (text ? new Date(Number(text)) : null);

async function factsOf(db: Database | Tx, profileId: string): Promise<Facts> {
  const result = await db.execute<{
    mode: string | null;
    verified_ms: string | null;
    held: string;
    refund_held: string;
    first_ms: string | null;
    withdrawals: number;
  }>(sql`
    SELECT ${profiles.collectionMode} AS mode,
           (extract(epoch FROM profiles.collect_verified_at) * 1000)::bigint::text AS verified_ms,
           (SELECT COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END), 0)
              FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
             WHERE a.code = 'held_for_recipients' AND a.profile_id = profiles.id)::text AS held,
           ${refundHeldSql(sql`profiles.id`)}::text AS refund_held,
           (SELECT (extract(epoch FROM min(t.completed_at)) * 1000)::bigint::text
              FROM collect_transfers c JOIN tips t ON t.id = c.tip_id
             WHERE c.profile_id = profiles.id AND c.kind = 'share' AND c.status IN ${HELD_SHARE}) AS first_ms,
           (SELECT count(*)::int FROM payouts o
             WHERE o.profile_id = profiles.id AND o.status <> 'FAILED'
               AND (profiles.collect_verified_at IS NULL
                    OR o.created_at >= profiles.collect_verified_at)) AS withdrawals
      FROM profiles
     WHERE profiles.id = ${profileId}`);
  const row = result.rows[0];
  if (!row) throw new OperationError('PROFILE_NOT_FOUND');
  return {
    mode: row.mode === 'collect' ? 'collect' : 'direct',
    verifiedAt: msOf(row.verified_ms),
    heldMinor: BigInt(row.held),
    refundHeldMinor: BigInt(row.refund_held),
    firstWaitingAt: msOf(row.first_ms),
    withdrawals: row.withdrawals,
  };
}

/**
 * A recipient's You collect state now, from the settings in force. Never writes. The withdrawal
 * guards run from verification (ruling P32): the first withdrawal after it is capped, and the daily
 * limit holds for `new_daily_limit_days` after it (and before it), so a recipient who signs up early
 * and verifies late still gets the whole guard.
 */
export async function collectStatus(
  db: Database | Tx,
  profileId: string,
  now: Date,
): Promise<CollectStatusResult> {
  const [facts, settings] = await Promise.all([
    factsOf(db, profileId),
    collectSettingsInForce(db, now),
  ]);
  const collecting = facts.mode === 'collect';
  const verified = facts.verifiedAt !== null;
  // The cap holds only money waiting for bank details: a verified recipient's moves on (§5).
  const capped = collecting && !verified;
  const pauseOn =
    capped && facts.firstWaitingAt
      ? new Date(facts.firstWaitingAt.getTime() + settings.capDays * DAY_MS)
      : null;
  const pausedReason =
    capped && facts.heldMinor > 0n && facts.heldMinor >= settings.capMinor
      ? 'amount'
      : pauseOn && now.getTime() >= pauseOn.getTime()
        ? 'days'
        : null;
  const young =
    facts.verifiedAt === null ||
    now.getTime() - facts.verifiedAt.getTime() <
      settings.newDailyLimitDays * DAY_MS;
  return {
    mode: facts.mode,
    verified,
    heldMinor: facts.heldMinor,
    ...heldParts(facts.heldMinor, facts.refundHeldMinor, verified),
    firstWaitingAt: facts.firstWaitingAt,
    paused: pausedReason !== null,
    pausedReason,
    pauseOn,
    firstWithdrawalCapMinor:
      collecting && facts.withdrawals === 0
        ? settings.firstWithdrawalCapMinor
        : null,
    dailyLimitMinor: collecting && young ? settings.newDailyLimitMinor : null,
  };
}

/**
 * A collect tip to this profile that isn't final yet (ruling P34), as a SQL condition on `tips`
 * joined to its `tip_quotes`: paid and being confirmed, or awaiting payment with an attempt still
 * live. An attempt whose checkout has opened, or is being opened, or whose outcome is unknown
 * (STARTING, INITIATED, PENDING, UNKNOWN) counts whatever its quote's expiry, as a checkout
 * outlives its quote and a late success is still booked. One still CREATED (no checkout opened)
 * counts only until its quote expires: no checkout can open after that, so an abandoned intent
 * stops holding room. Mirrors `balanceQuery`'s "confirming", widened to every live attempt.
 */
function unfinishedTip(now: Date) {
  return sql`(tips.status = 'PENDING_VERIFICATION'
    OR (tips.status = 'AWAITING_PAYMENT' AND EXISTS (
          SELECT 1 FROM payment_attempts pa
           WHERE pa.intent_id = tips.intent_id
             AND (pa.status IN ('STARTING', 'INITIATED', 'PENDING', 'UNKNOWN')
                  OR (pa.status = 'CREATED'
                      AND tip_quotes.expires_at > ${now.toISOString()}::timestamptz)))))`;
}

/** Unfinished collect intents one supporter address may hold on a page at once (ruling P34). */
export const UNFINISHED_INTENTS_PER_ADDRESS = 2;

/**
 * The holding cap's upper bound (spec §2.1 step 7, rulings P31 and P34; fix rounds 2 and 3), for a
 * tip to an unverified collect page: what is held, plus the recipient's net on every collect tip
 * that isn't final yet (`unfinishedTip`), plus this tip's net, may never exceed `cap_minor`. The
 * net counted is the tip's whole net to the recipient, before any business share is taken from it:
 * on purpose, as counting too much only errs safe. Bare quotes never count: they are anonymous and
 * free, so counting them would let anyone block a page. The quote asks this as a courtesy; the
 * intent's ask (`binding`) is the one that holds, after taking the profile row lock, so intents
 * made at once are counted one after another and together never overshoot. At the intent one
 * supporter address (`addressKey`) may also hold at most `UNFINISHED_INTENTS_PER_ADDRESS`
 * unfinished intents on the page, so one person's abandoned checkouts can't keep it paused. Every
 * refusal is the same `PAGE_PAUSED`, paused, no room or too many from one address alike, so trying
 * amounts reveals nothing about what is held (§2.2). A verified page has no cap, and is never
 * locked here.
 */
export async function refuseOverHoldingCap(
  tx: Tx,
  i: {
    profileId: string;
    now: Date;
    /** This tip's net to the recipient. */
    addMinor: bigint;
    /** The intent's check: take the profile lock first. */
    binding: boolean;
    /** At the intent: the keyed hash of the supporter's address, when it is known. */
    addressKey?: string | undefined;
  },
): Promise<void> {
  const [mark] = (
    await tx.execute<{ verified: boolean }>(
      sql`SELECT profiles.collect_verified_at IS NOT NULL AS verified
            FROM profiles WHERE profiles.id = ${i.profileId}`,
    )
  ).rows;
  if (!mark || mark.verified) return;
  if (i.binding)
    await tx.execute(
      sql`SELECT 1 FROM profiles WHERE profiles.id = ${i.profileId} FOR UPDATE`,
    );
  // Tips still being paid are read BEFORE held money, and the order matters. Each statement sees
  // what had committed when it began (READ COMMITTED), and a booking moves a tip from one to the
  // other in one commit. Read in this order, a booking committing between the two is counted twice
  // (safe: a refusal); the other way round it would be in neither, and the cap could be overshot.
  const open = await tx.execute<{ pending: string; mine: number }>(sql`
    SELECT COALESCE(SUM(tip_quotes.recipient_net_minor), 0)::text AS pending,
           count(*) FILTER (WHERE payment_intents.address_key = ${i.addressKey ?? null})::int AS mine
      FROM tips
      JOIN payment_intents ON payment_intents.id = tips.intent_id
      JOIN tip_quotes ON tip_quotes.id = payment_intents.quote_id
     WHERE tips.profile_id = ${i.profileId}
       AND ${tipQuotes.collectionMode} = 'collect'
       AND ${unfinishedTip(i.now)}`);
  const pending = BigInt(open.rows[0]?.pending ?? '0');
  const status = await collectStatus(tx, i.profileId, i.now);
  // Verified while this waited for the lock: no cap any more.
  if (status.verified) return;
  if (status.paused) throw new OperationError('PAGE_PAUSED');
  if (
    i.binding &&
    i.addressKey &&
    (open.rows[0]?.mine ?? 0) >= UNFINISHED_INTENTS_PER_ADDRESS
  )
    throw new OperationError('PAGE_PAUSED');
  const settings = await collectSettingsInForce(tx, i.now);
  if (status.heldMinor + pending + i.addMinor > settings.capMinor)
    throw new OperationError('PAGE_PAUSED');
}

/**
 * What a collect recipient may still withdraw under the new-account guards (spec §8), at `now`:
 * the first-withdrawal cap while they have none, and what is left of the Lagos day's limit while
 * their account is young (withdrawals asked for and not failed count, their fee included). Null
 * where a guard doesn't apply, and both null for a direct recipient. Called under the profile lock
 * a withdrawal request holds, so two at once can't both use the same room.
 */
export async function collectWithdrawalRoom(
  tx: Database | Tx,
  profileId: string,
  now: Date,
): Promise<{
  firstCapMinor: bigint | null;
  dailyLimitMinor: bigint | null;
  dailyLeftMinor: bigint | null;
}> {
  const status = await collectStatus(tx, profileId, now);
  if (status.dailyLimitMinor === null)
    return {
      firstCapMinor: status.firstWithdrawalCapMinor,
      dailyLimitMinor: null,
      dailyLeftMinor: null,
    };
  const start = lagosDayStart(now);
  const end = new Date(start.getTime() + DAY_MS);
  const result = await tx.execute<{ spent: string }>(sql`
    SELECT COALESCE(SUM(o.amount_minor + o.user_fee_minor), 0)::text AS spent
      FROM payouts o
     WHERE o.profile_id = ${profileId} AND o.status <> 'FAILED'
       AND o.created_at >= ${start.toISOString()}::timestamptz
       AND o.created_at < ${end.toISOString()}::timestamptz`);
  const spent = BigInt(result.rows[0]?.spent ?? '0');
  const left = status.dailyLimitMinor - spent;
  return {
    firstCapMinor: status.firstWithdrawalCapMinor,
    dailyLimitMinor: status.dailyLimitMinor,
    dailyLeftMinor: left > 0n ? left : 0n,
  };
}

/** Refuses an amount above the room left (the limit rides as the error's detail, for its words). */
export function refuseOverCollectLimits(
  amountMinor: bigint,
  room: Awaited<ReturnType<typeof collectWithdrawalRoom>>,
): void {
  if (room.firstCapMinor !== null && amountMinor > room.firstCapMinor)
    throw new OperationError(
      'WITHDRAWAL_FIRST_CAP',
      String(room.firstCapMinor),
    );
  if (
    room.dailyLimitMinor !== null &&
    room.dailyLeftMinor !== null &&
    amountMinor > room.dailyLeftMinor
  )
    throw new OperationError(
      'WITHDRAWAL_DAILY_LIMIT',
      String(room.dailyLimitMinor),
    );
}

/** The most the guards let leave now, against `withdrawable`. */
export function withinCollectLimits(
  withdrawableMinor: bigint,
  room: Awaited<ReturnType<typeof collectWithdrawalRoom>>,
): bigint {
  let most = withdrawableMinor;
  if (room.firstCapMinor !== null && room.firstCapMinor < most)
    most = room.firstCapMinor;
  if (room.dailyLeftMinor !== null && room.dailyLeftMinor < most)
    most = room.dailyLeftMinor;
  return most;
}

const LONG_MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
/** "20 December": the Lagos calendar day of `at` (Lagos is UTC+1 all year). */
function lagosDay(at: Date): string {
  const local = new Date(at.getTime() + 3_600_000);
  return `${local.getUTCDate()} ${LONG_MONTHS[local.getUTCMonth()]}`;
}

const naira = (minor: bigint) =>
  `₦${new Intl.NumberFormat('en').format(minor / 100n)}${
    minor % 100n === 0n ? '' : `.${String(minor % 100n).padStart(2, '0')}`
  }`;

/**
 * A notification's id from its dedupe key, so a reminder is stored once per (profile, day) however
 * often the sweep runs or races itself: the primary key is the dedupe, and no column is needed.
 * Shaped as a version-5-style UUID from the key's SHA-256.
 */
export function idFromKey(key: string): string {
  const hex = createHash('sha256').update(key).digest('hex');
  const variant = ((parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Reminds collect recipients with money waiting and no verified bank details (spec §2.1 step 3):
 * an in-app notice and an email, on each day in `reminder_days` after their first waiting tip,
 * once per (profile, waiting spell, day) by the dedupe key `collect_reminder.<profileId>.<spell>.<day>`
 * (the spell is the first waiting tip's Lagos day). Only the latest
 * reminder day reached is sent, so a sweep that missed a day never sends two at once; none is sent
 * once the cap's days have passed (the page has paused). The last reminder day says when the page
 * pauses: `firstWaitingAt + cap_days`, on the Lagos calendar. Returns how many were sent.
 */
export function sendCollectReminders(
  db: Database,
  i: { now: Date; sealing: MailSealing },
): Promise<number> {
  return guarded(async () => {
    const settings = await collectSettingsInForce(db, i.now);
    const lastDay = Math.max(...settings.reminderDays);
    const result = await db.execute<{ id: string }>(sql`
      SELECT profiles.id FROM profiles
       WHERE ${profiles.collectionMode} = 'collect' AND profiles.collect_verified_at IS NULL
         AND profiles.user_id IS NOT NULL
         AND EXISTS (SELECT 1 FROM collect_transfers c
                      WHERE c.profile_id = profiles.id AND c.kind = 'share' AND c.status IN ${HELD_SHARE})`);
    let sent = 0;
    for (const { id: profileId } of result.rows) {
      const status = await collectStatus(db, profileId, i.now);
      if (
        status.mode !== 'collect' ||
        status.verified ||
        status.heldMinor <= 0n ||
        !status.firstWaitingAt
      )
        continue;
      const elapsed = i.now.getTime() - status.firstWaitingAt.getTime();
      if (elapsed >= settings.capDays * DAY_MS) continue;
      const due = settings.reminderDays.filter((d) => elapsed >= d * DAY_MS);
      const day = due.at(-1);
      if (day === undefined) continue;
      // The last reminder says the page will pause; a page already paused by amount gets the
      // waiting words instead (M7), which stay true.
      const kind =
        day === lastDay && status.pausedReason !== 'amount'
          ? 'last'
          : 'waiting';
      const byDate = lagosDay(
        new Date(status.firstWaitingAt.getTime() + settings.capDays * DAY_MS),
      );
      const body =
        kind === 'last'
          ? `Add your bank details by ${byDate}, or your page will pause new tips.`
          : `You have ${naira(status.heldMinor)} in tips waiting. Add your bank details to withdraw it.`;
      // The waiting spell is in the key (M6): once every held share is settled and money waits
      // again, its first tip's day differs, so the new spell is reminded from day one.
      const spell = new Date(status.firstWaitingAt.getTime() + 3_600_000)
        .toISOString()
        .slice(0, 10);
      const dedupeKey = `collect_reminder.${profileId}.${spell}.${day}`;
      const created = await db.transaction(async (tx) => {
        const facts = await tx.execute<{
          user_id: string;
          display_name: string;
          email: string | null;
          email_verified: boolean;
          deleted: boolean;
          verified: boolean;
        }>(sql`
          SELECT p.user_id, p.display_name, u.email,
                 u.email_verified_at IS NOT NULL AS email_verified,
                 u.deleted_at IS NOT NULL AS deleted,
                 p.collect_verified_at IS NOT NULL AS verified
            FROM profiles p JOIN users u ON u.id = p.user_id
           WHERE p.id = ${profileId}
           FOR UPDATE OF p`);
        const row = facts.rows[0];
        // Verified meanwhile: their money is on its way, no reminder.
        if (!row || row.verified) return false;
        const inserted = await tx
          .insert(notifications)
          .values({
            id: idFromKey(dedupeKey),
            userId: row.user_id,
            kind: 'collect_reminder',
            title: 'Add your bank details',
            body,
            createdAt: i.now,
          })
          .onConflictDoNothing()
          .returning({ id: notifications.id });
        if (inserted.length === 0) return false;
        if (row.email && row.email_verified && !row.deleted)
          await enqueueMail(tx, i.sealing, {
            type: 'collect_reminder',
            to: row.email,
            userId: row.user_id,
            data: {
              firstName:
                row.display_name.split(/\s+/)[0] || row.display_name || 'there',
              kind,
              heldMinor: status.heldMinor.toString(),
              byDate,
            },
            dedupeKey,
            now: i.now,
          });
        return true;
      });
      if (created) sent += 1;
    }
    return sent;
  });
}
