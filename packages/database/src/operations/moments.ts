import type { MomentView } from '@tipme/contracts';
import { cashBonusAmount, REWARDS, type MilestoneReward } from '@tipme/domain';
import { and, desc, eq, gt, isNotNull, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  feeFreeCredits,
  moments,
  notifications,
  profiles,
  rewardBudget,
  rewardGrants,
} from '../schema.js';
import { guarded } from './errors.js';
import { mailOwner } from './account-mail.js';
import type { MailSealing } from './mail-queue.js';
import { newId } from './ids.js';
import { isoWeekOf } from './reports.js';
import { postCashReward } from './rewards.js';

const ZONE = 'Africa/Lagos';
const ngn = (minor: bigint) =>
  `NGN ${new Intl.NumberFormat('en').format(Number(minor / 100n))}.${String(minor % 100n).padStart(2, '0')}`;
const monthOf = (date: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
  }).format(date);

/** Lifetime fees a recipient earned TipMe, what TipMe gave back, and fees since the last cash bonus. */
export async function rewardStats(
  tx: Database | Tx,
  profileId: string,
): Promise<{
  lifetimeFeesMinor: bigint;
  lifetimeRewardCostMinor: bigint;
  feesSinceLastCashMinor: bigint;
}> {
  const result = await tx.execute<{
    fees: string;
    waived: string;
    cash: string;
    since: string;
  }>(sql`
    WITH paid AS (
      SELECT q.platform_fee_minor AS fee, q.waived_platform_fee_minor AS waived, t.completed_at
        FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
       WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED'),
    last_cash AS (
      SELECT MAX(created_at) AS at FROM reward_grants WHERE profile_id = ${profileId} AND cash_minor > 0)
    SELECT COALESCE((SELECT SUM(fee) FROM paid), 0)::text AS fees,
           COALESCE((SELECT SUM(waived) FROM paid), 0)::text AS waived,
           COALESCE((SELECT SUM(cash_minor) FROM reward_grants WHERE profile_id = ${profileId}), 0)::text AS cash,
           COALESCE((SELECT SUM(fee) FROM paid, last_cash
                      WHERE last_cash.at IS NULL OR paid.completed_at > last_cash.at), 0)::text AS since`);
  const row = result.rows[0];
  return {
    lifetimeFeesMinor: BigInt(row?.fees ?? '0'),
    lifetimeRewardCostMinor:
      BigInt(row?.waived ?? '0') + BigInt(row?.cash ?? '0'),
    feesSinceLastCashMinor: BigInt(row?.since ?? '0'),
  };
}

export async function addCredits(tx: Tx, profileId: string, count: number) {
  await tx
    .insert(feeFreeCredits)
    .values({ profileId, remaining: count })
    .onConflictDoUpdate({
      target: feeFreeCredits.profileId,
      set: { remaining: sql`${feeFreeCredits.remaining} + ${count}` },
    });
}

/** A cash bonus within the lifetime cap and this month's budget (locked), or 0. */
async function payCash(
  tx: Tx,
  input: {
    profileId: string;
    momentId: string;
    now: Date;
    budgetPerMonthMinor: bigint;
    reserveMinor: bigint;
  },
): Promise<bigint> {
  const month = monthOf(input.now);
  await tx
    .insert(rewardBudget)
    .values({ month, spentMinor: 0n })
    .onConflictDoNothing();
  const [budget] = await tx
    .select({ spent: rewardBudget.spentMinor })
    .from(rewardBudget)
    .where(eq(rewardBudget.month, month))
    .for('update');
  const remaining = input.budgetPerMonthMinor - (budget?.spent ?? 0n);
  const stats = await rewardStats(tx, input.profileId);
  const amount = cashBonusAmount({
    ...stats,
    budgetRemainingMinor: remaining > 0n ? remaining : 0n,
    reserveMinor: input.reserveMinor,
  });
  if (amount <= 0n) return 0n;
  await postCashReward(tx, {
    profileId: input.profileId,
    amountMinor: amount,
    currency: 'NGN',
    operationKey: `reward.${input.momentId}`,
  });
  await tx
    .update(rewardBudget)
    .set({ spentMinor: sql`${rewardBudget.spentMinor} + ${amount}` })
    .where(eq(rewardBudget.month, month));
  return amount;
}

/**
 * What a fee-free tip typically costs TipMe for this recipient: its whole share (TipMe's fee plus
 * the processing it pays from it, PR-012), averaged over their last 20 paid, non-fee-free tips.
 */
async function typicalFee(tx: Tx, profileId: string): Promise<bigint> {
  const result = await tx.execute<{ fee: string | null }>(sql`
    SELECT AVG(fee)::bigint::text AS fee FROM (
      SELECT q.platform_fee_minor + q.provider_fee_minor AS fee
        FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
       WHERE t.profile_id = ${profileId} AND t.status = 'SUCCEEDED' AND q.waived_platform_fee_minor = 0
       ORDER BY t.completed_at DESC LIMIT 20) recent`);
  return BigInt(result.rows[0]?.fee ?? '0');
}

type Copy = (granted: { cash: bigint; feeFree: number }) => string;

/**
 * Creates a moment once (its key is unique, so concurrent attempts make one) and gives its reward
 * in the same transaction: fee-free tips, a capped cash bonus, or (when cash cannot be paid) the
 * fallback fee-free tips. Returns false when the moment already existed.
 */
async function createMoment(
  tx: Tx,
  input: {
    profileId: string;
    key: string;
    kind: string;
    reward: MilestoneReward;
    copy: Copy;
    now: Date;
    budgetPerMonthMinor: bigint;
    sealing: MailSealing;
  },
): Promise<boolean> {
  const momentId = newId();
  const inserted = await tx
    .insert(moments)
    .values({
      id: momentId,
      profileId: input.profileId,
      key: input.key,
      kind: input.kind,
      title: '',
    })
    .onConflictDoNothing({ target: moments.key })
    .returning({ id: moments.id });
  if (!inserted[0]) return false;
  const reward = input.reward;
  let cash = 0n;
  let feeFree = 0;
  if (reward !== 'none') {
    const wantsCash = reward === 'cash' || ('cash' in reward && reward.cash);
    feeFree = typeof reward === 'object' ? reward.feeFree : 0;
    const fee = await typicalFee(tx, input.profileId);
    if (wantsCash) {
      cash = await payCash(tx, {
        profileId: input.profileId,
        momentId,
        now: input.now,
        budgetPerMonthMinor: input.budgetPerMonthMinor,
        reserveMinor: fee * BigInt(feeFree),
      });
      if (cash === 0n) feeFree += REWARDS.fallbackFeeFree;
    }
    // Never promise fee-free tips the lifetime cap could not honour.
    const stats = await rewardStats(tx, input.profileId);
    const room =
      (stats.lifetimeFeesMinor * REWARDS.lifetimeCapBps) / 10000n -
      stats.lifetimeRewardCostMinor;
    const affordable = fee > 0n && room > 0n ? Number(room / fee) : 0;
    feeFree = Math.max(0, Math.min(feeFree, affordable));
    if (feeFree > 0) await addCredits(tx, input.profileId, feeFree);
    await tx.insert(rewardGrants).values({
      id: newId(),
      momentId,
      profileId: input.profileId,
      kind: cash > 0n ? 'cash' : 'fee_free',
      feeFreeCount: feeFree,
      cashMinor: cash,
    });
  }
  const title = input.copy({ cash, feeFree });
  await tx.update(moments).set({ title }).where(eq(moments.id, momentId));
  const [owner] = await tx
    .select({ userId: profiles.userId, wants: profiles.notifyMilestones })
    .from(profiles)
    .where(eq(profiles.id, input.profileId));
  // The moment and any reward still happen; only the notice follows the preference (PR-013).
  if (owner?.userId && owner.wants)
    await tx.insert(notifications).values({
      id: newId(),
      userId: owner.userId,
      kind: 'moment',
      momentId,
      title,
      body: 'Share it on your page if you like.',
    });
  if (input.kind === 'milestone') {
    // Like tip emails: turned off means never queued, not queued and dropped later.
    const [page] = await tx
      .select({ wants: profiles.notifyMilestones })
      .from(profiles)
      .where(eq(profiles.id, input.profileId));
    if (page?.wants)
      await mailOwner(tx, input.sealing, {
        profileId: input.profileId,
        type: 'milestone',
        data: { copy: title },
        dedupeKey: `milestone.${momentId}`,
        now: input.now,
      });
  }
  return true;
}

const freeText = (count: number) => `your next ${count} tips are fee-free`;
const milestoneCopy =
  (count: number): Copy =>
  ({ cash, feeFree }) => {
    if (count === 1) return 'Your first tip! Someone noticed your work.';
    if (cash > 0n && feeFree > 0)
      return `${count} tips! ${ngn(cash)} and ${freeText(feeFree)}.`;
    if (cash > 0n)
      return `${count} tips! A thank-you from TipMe: ${ngn(cash)} added to your balance.`;
    if (feeFree > 0)
      return `${count} tips! Your next ${feeFree} tips are fee-free.`;
    return `${count} tips! People keep coming back to thank you.`;
  };

/**
 * After a verified tip: milestones reached (each once, catching up if one was missed) and the
 * week's first lovely note.
 */
export function evaluateTipMoments(
  db: Database,
  input: {
    profileId: string;
    tipId: string;
    now: Date;
    budgetPerMonthMinor: bigint;
    sealing: MailSealing;
  },
): Promise<{ created: string[] }> {
  return guarded(() =>
    db.transaction(async (tx) => {
      // A page TipMe suspended earns no new moments or rewards (PR-009).
      const status = await tx.execute<{ status: string }>(
        sql`SELECT status FROM profiles WHERE id = ${input.profileId}`,
      );
      if (status.rows[0]?.status !== 'active') return { created: [] };
      const counts = await tx.execute<{
        paid: number;
        has_message: boolean;
      }>(sql`
        SELECT (SELECT COUNT(*)::int FROM tips WHERE profile_id = ${input.profileId} AND status = 'SUCCEEDED') AS paid,
               EXISTS (SELECT 1 FROM tip_messages m JOIN tips t ON t.id = m.tip_id
                        WHERE m.tip_id = ${input.tipId} AND t.profile_id = ${input.profileId} AND t.status = 'SUCCEEDED') AS has_message`);
      const paid = counts.rows[0]?.paid ?? 0;
      const created: string[] = [];
      for (const milestone of REWARDS.milestones) {
        if (paid < milestone.count) continue;
        const key = `milestone.${milestone.count}.${input.profileId}`;
        if (
          await createMoment(tx, {
            ...input,
            key,
            kind: 'milestone',
            reward: milestone.reward,
            copy: milestoneCopy(milestone.count),
          })
        )
          created.push(key);
      }
      if (counts.rows[0]?.has_message) {
        const key = `note.${isoWeekOf(input.now)}.${input.profileId}`;
        if (
          await createMoment(tx, {
            ...input,
            key,
            kind: 'note',
            reward: 'none',
            copy: () => 'Someone left you a lovely note.',
          })
        )
          created.push(key);
      }
      return { created };
    }),
  );
}

/**
 * After a week or month has closed: "best so far", only with enough history (4 earlier weeks or
 * 2 earlier months with tips), at least 5 tips in the period, and beating the previous best.
 */
export function evaluatePeriodMoments(
  db: Database,
  input: {
    period: 'week' | 'month';
    periodKey: string;
    now: Date;
    budgetPerMonthMinor: bigint;
    sealing: MailSealing;
  },
): Promise<{ created: number }> {
  const format = input.period === 'week' ? 'IYYY-"W"IW' : 'YYYY-MM';
  const minPrior =
    input.period === 'week'
      ? REWARDS.bestPeriod.minPriorWeeks
      : REWARDS.bestPeriod.minPriorMonths;
  return guarded(async () => {
    const rows = await db.execute<{
      profile_id: string;
      period: string;
      total: string;
      tips: number;
    }>(sql`
      SELECT t.profile_id, to_char((t.completed_at AT TIME ZONE ${ZONE})::date, ${format}) AS period,
             SUM(q.recipient_net_minor)::text AS total, COUNT(*)::int AS tips
        FROM tips t JOIN payment_intents i ON i.id = t.intent_id JOIN tip_quotes q ON q.id = i.quote_id
        JOIN profiles p ON p.id = t.profile_id
       WHERE t.status = 'SUCCEEDED' AND p.page_state <> 'deleted' AND p.status = 'active'
       GROUP BY 1, 2`);
    const byProfile = new Map<
      string,
      { period: string; total: bigint; tips: number }[]
    >();
    for (const row of rows.rows) {
      const list = byProfile.get(row.profile_id) ?? [];
      list.push({
        period: row.period,
        total: BigInt(row.total),
        tips: row.tips,
      });
      byProfile.set(row.profile_id, list);
    }
    let created = 0;
    for (const [profileId, periods] of byProfile) {
      const current = periods.find((p) => p.period === input.periodKey);
      const prior = periods.filter((p) => p.period < input.periodKey);
      if (
        !current ||
        prior.length < minPrior ||
        current.tips < REWARDS.bestPeriod.minTipsInPeriod
      )
        continue;
      if (!prior.every((p) => current.total > p.total)) continue;
      const isWeek = input.period === 'week';
      const made = await db.transaction((tx) =>
        createMoment(tx, {
          profileId,
          key: `${isWeek ? 'best_week' : 'best_month'}.${input.periodKey}.${profileId}`,
          kind: isWeek ? 'best_week' : 'best_month',
          reward: isWeek ? REWARDS.bestWeek : REWARDS.bestMonth,
          copy: ({ cash, feeFree }) =>
            isWeek
              ? 'Your best week so far.'
              : cash > 0n
                ? `Your best month so far — ${ngn(cash)} from TipMe.`
                : feeFree > 0
                  ? `Your best month so far — ${freeText(feeFree)}.`
                  : 'Your best month so far.',
          now: input.now,
          budgetPerMonthMinor: input.budgetPerMonthMinor,
          sealing: input.sealing,
        }),
      );
      if (made) created += 1;
    }
    return { created };
  });
}

export function listMoments(
  db: Database,
  profileId: string,
): Promise<MomentView[]> {
  return guarded(async () =>
    (
      await db
        .select()
        .from(moments)
        .where(eq(moments.profileId, profileId))
        .orderBy(desc(moments.createdAt), desc(moments.key))
        .limit(50)
    ).map((row) => ({
      id: row.id,
      key: row.key,
      kind: row.kind,
      title: row.title,
      sharedAt: row.sharedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    })),
  );
}

/** Shares one of the user's own moments on their public page (for 14 days). */
export function shareMoment(
  db: Database,
  userId: string,
  momentId: string,
): Promise<{ handle: string } | null> {
  if (!/^[0-9a-f-]{36}$/.test(momentId)) return Promise.resolve(null);
  return guarded(async () => {
    const [row] = await db
      .select({ profileId: moments.profileId, handle: profiles.handleLower })
      .from(moments)
      .innerJoin(profiles, eq(profiles.id, moments.profileId))
      .where(and(eq(moments.id, momentId), eq(profiles.userId, userId)));
    if (!row) return null;
    await db
      .update(moments)
      .set({ sharedAt: new Date() })
      .where(eq(moments.id, momentId));
    return { handle: row.handle };
  });
}

const ordinal = (n: number) =>
  n === 1
    ? 'first'
    : `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')}`;

/**
 * The public words for a moment, from its kind only: never its reward (cash or fee-free tips
 * are the recipient's own business). "10th tip", "best week so far", ...
 */
export function publicMomentLabel(key: string): string {
  const [kind, value] = key.split('.');
  if (kind === 'milestone') return `${ordinal(Number(value))} tip`;
  if (kind === 'best_week') return 'best week so far';
  if (kind === 'best_month') return 'best month so far';
  return 'lovely note';
}

/** The page's current public celebration: the latest shared moment of the last 14 days. */
export async function publicCelebration(
  tx: Database | Tx,
  profileId: string,
): Promise<{ momentId: string; label: string } | undefined> {
  const since = new Date(Date.now() - REWARDS.publicWindowDays * 86_400_000);
  const [row] = await tx
    .select({ momentId: moments.id, key: moments.key })
    .from(moments)
    .where(
      and(
        eq(moments.profileId, profileId),
        isNotNull(moments.sharedAt),
        gt(moments.sharedAt, since),
      ),
    )
    .orderBy(desc(moments.sharedAt))
    .limit(1);
  return row
    ? { momentId: row.momentId, label: publicMomentLabel(row.key) }
    : undefined;
}
