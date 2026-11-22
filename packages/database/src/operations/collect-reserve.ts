import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  collectReserveAlerts,
  collectReserveReadings,
  issues,
  type IssueKind,
} from '../schema.js';
import { collectSettingsInForce } from './collect-settings.js';
import { guarded } from './errors.js';
import { readFeatureSwitch } from './feature-switches.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';
import {
  claimReserveAlert,
  nairaText,
  RESERVE_STALE_AFTER_MS,
} from './payment-reserve.js';

/*
 * You collect's reserve invariant (plan Task 11, spec §4 and §6.3; rulings P9, P10, P11). TipMe holds
 * each collect recipient's money in its own partner balance (`held_for_recipients`), so in every
 * currency:
 *
 *   partner platform available  >=  Σ held_for_recipients
 *
 * and TipMe's own money is the difference. Each reserve check (every 15 minutes, beside today's NGN
 * payout-fee check, which is unchanged) records one reading per currency in
 * `collect_reserve_readings` and tells people:
 *
 *   warning   own < the warning level (NGN, admin-settable)          staff alert
 *   critical  own < the critical level, or any balance below zero     staff paged, owners emailed,
 *                                                                     voluntary own-money moves refused
 *   broken    own < 0 where money is held (the rule broken)          as critical, plus a
 *                                                                     `collect_invariant_broken` issue that
 *                                                                     pauses You collect sign-ups until
 *                                                                     staff clear it
 *
 * Alerts follow today's rule: once per level per spell, again every 6 hours while it lasts, claimed
 * under an advisory lock so two checks at once send one (`claimReserveAlert`). Automatic payouts on
 * TipMe's own balance open `collect_auto_payout_on` (critical), alerted once per spell.
 *
 * While You collect is not in use (switch off and nothing held) the own-money levels don't apply, so
 * nothing changes for today's direct-only TipMe (P10); a negative balance is still critical.
 */

const IN_FLIGHT_LOCK = 'collect_reserve';

/** Σ held_for_recipients (debits less credits) in a currency: what TipMe holds for recipients. */
export function heldTotal(
  db: Database | Tx,
  currency: string,
): Promise<bigint> {
  return guarded(async () => (await heldTotals(db)).get(currency) ?? 0n);
}

async function heldTotals(db: Database | Tx): Promise<Map<string, bigint>> {
  const result = await db.execute<{ currency: string; held: string }>(sql`
    SELECT e.currency,
           SUM(CASE WHEN e.side = 'debit' THEN e.amount_minor ELSE -e.amount_minor END)::text AS held
      FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
     WHERE a.code = 'held_for_recipients'
     GROUP BY e.currency`);
  return new Map(result.rows.map((r) => [r.currency, BigInt(r.held)]));
}

/** What a reserve check reads of TipMe's own account (structural: no adapter import, ADR-0004). */
export interface CollectReserveReader {
  name: string;
  platformBalances(): Promise<
    { currency: string; availableMinor: bigint; pendingMinor?: bigint }[]
  >;
  platformPayoutSchedule(): Promise<Record<string, string>>;
}

export type CollectReserveLevel = 'ok' | 'warning' | 'critical' | 'broken';

export interface CollectReserveResult {
  perCurrency: {
    currency: string;
    availableMinor: bigint;
    heldMinor: bigint;
    ownMinor: bigint;
    level: CollectReserveLevel;
  }[];
  /** Null when the schedule could not be read. */
  autoPayoutOn: boolean | null;
  /** The balances could not be read: every currency holding money is recorded as unknown. */
  unreadable?: true;
  /** A negative balance in a currency TipMe doesn't list blocked the read (review I4). */
  unlistedNegative?: string;
}

const STORED_LEVEL: Record<CollectReserveLevel, string> = {
  ok: 'ok',
  warning: 'warning',
  critical: 'critical',
  broken: 'breach',
};

/** A currency's own amount as staff read it: naira as ₦, any other as "15.00 USD". */
export function moneyText(minor: bigint, currency: string): string {
  if (currency === 'NGN') return nairaText(minor);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  return `${negative ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')} ${currency}`;
}

/** Whether You collect is in use: the switch on, or money still held for anyone. */
async function collectInUse(
  db: Database | Tx,
  held: Map<string, bigint>,
): Promise<boolean> {
  if ([...held.values()].some((v) => v > 0n)) return true;
  return readFeatureSwitch(db, 'you_collect');
}

/** One open issue of a kind per spell (a closed one never swallows the next): opened says it's new. */
async function openSpellIssue(
  tx: Tx,
  i: { kind: IssueKind; scope: string; note: string; now: Date },
): Promise<boolean> {
  const prefix = `${i.kind}.${i.scope}.`;
  const [open] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.kind, i.kind),
        eq(issues.status, 'open'),
        sql`${issues.dedupeKey} LIKE ${`${prefix}%`}`,
      ),
    )
    .limit(1);
  if (open) return false;
  const { opened } = await openIssue(tx, {
    dedupeKey: `${prefix}${newId()}`,
    kind: i.kind,
    subject: {},
    note: i.note,
    now: i.now,
  });
  return opened;
}

/** A condition of the check that isn't one currency's level (review I4, I5). */
type Condition = 'auto_payout' | 'unreadable' | 'unlisted_negative';

/** An alert this check may send: claimed under the lock, sent after it. */
interface Pending {
  table: 'collect_reserve_readings' | 'collect_reserve_alerts';
  rowId: string;
  level: 'warning' | 'critical';
  text: string;
  /** The staff alert was claimed (not one in flight, nor sent in this spell within 6 hours). */
  claimed: boolean;
  /** Owners are emailed for this kind (critical, broken, a negative unlisted bucket, auto payouts). */
  emailOwners: boolean;
}

const UNLISTED = /^[A-Z0-9_]{1,32}$/;

/**
 * Whether owners were emailed in this kind's current spell (review I5, m1): once per spell, apart
 * from the staff alert, so an unset or failing alert route never stops them hearing, and a 6-hourly
 * repeat never emails them again.
 */
async function ownersEmailedInSpell(
  tx: Tx,
  i: {
    table: 'collect_reserve_readings' | 'collect_reserve_alerts';
    provider: string;
    scope: string;
    kind: SQL;
    fine: SQL;
  },
): Promise<boolean> {
  const table = sql.identifier(i.table);
  const column = sql.identifier(
    i.table === 'collect_reserve_alerts' ? 'condition' : 'currency',
  );
  const [row] = (
    await tx.execute(sql`
      SELECT coalesce(bool_or(owners_emailed_at IS NOT NULL), false) AS emailed
        FROM ${table}
       WHERE provider = ${i.provider} AND ${column} = ${i.scope} AND ${i.kind}
         AND read_at > coalesce(
           (SELECT max(read_at) FROM ${table}
             WHERE provider = ${i.provider} AND ${column} = ${i.scope} AND ${i.fine}),
           '-infinity'::timestamptz)`)
  ).rows as { emailed: boolean }[];
  return row?.emailed === true;
}

/**
 * One reserve check of TipMe's own money (see the header). The partner reads and the alert and email
 * calls are never made under the lock. A staff alert that fails gives its claim back, so the next
 * check sends it. Owners are emailed once per spell of a critical, broken or platform-wide condition,
 * whatever the staff alert route did (review I5).
 */
export function checkCollectReserve(
  db: Database,
  i: {
    provider: CollectReserveReader;
    alert(text: string, level: 'warning' | 'critical'): Promise<void>;
    emailOwners(text: string): Promise<void>;
    now: Date;
  },
): Promise<CollectReserveResult> {
  const { now } = i;
  const provider = i.provider.name;
  return guarded(async () => {
    // Before any partner call (m9): with You collect not in use, the schedule isn't asked for.
    const inUseBefore = await collectInUse(db, await heldTotals(db));
    // A failed read is a normal answer ("unknown"); its error is never kept: it may carry details.
    // A negative balance in a currency TipMe doesn't list (a crypto bucket) is not "unknown": the
    // adapter refuses the whole read for it, and it blocks every transfer (review I4).
    let unlisted: string | null = null;
    const balances = await i.provider.platformBalances().catch((error) => {
      if (
        error instanceof Error &&
        error.name === 'UnlistedNegativeBalanceError'
      ) {
        const bucket = (error as Error & { currency?: unknown }).currency;
        unlisted =
          typeof bucket === 'string' && UNLISTED.test(bucket)
            ? bucket
            : 'UNKNOWN';
      }
      return null;
    });
    const schedule = inUseBefore
      ? await i.provider.platformPayoutSchedule().catch(() => null)
      : null;
    const autoPayoutOn = schedule
      ? Object.values(schedule).some((interval) => interval !== 'manual')
      : null;
    const settings = await collectSettingsInForce(db, now);

    const { perCurrency, pending } = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${`${IN_FLIGHT_LOCK}:${provider}`}::text))`,
      );
      // Read under the lock, so a reading's held total is the one its level was decided on.
      const held = await heldTotals(tx);
      const inUse = await collectInUse(tx, held);
      const anyHeld = [...held.values()].some((v) => v > 0n);
      const currencies = new Set<string>(
        [...held.entries()].filter(([, v]) => v > 0n).map(([c]) => c),
      );
      for (const b of balances ?? []) currencies.add(b.currency);
      const rows: CollectReserveResult['perCurrency'] = [];
      const pending: Pending[] = [];
      for (const currency of [...currencies].sort()) {
        const heldMinor =
          (held.get(currency) ?? 0n) > 0n ? held.get(currency)! : 0n;
        const listed = balances?.find((b) => b.currency === currency);
        // A currency the partner doesn't list while TipMe holds money in it reads as zero.
        const availableMinor =
          balances === null ? null : (listed?.availableMinor ?? 0n);
        const levels =
          inUse && currency === 'NGN'
            ? {
                warning: settings.reserveWarningMinor,
                critical: settings.reserveCriticalMinor,
              }
            : { warning: 0n, critical: 0n };
        if (availableMinor === null) {
          await tx.insert(collectReserveReadings).values({
            id: newId(),
            provider,
            currency,
            availableMinor: null,
            heldMinor,
            ownMinor: null,
            warningMinor: levels.warning,
            criticalMinor: levels.critical,
            level: null,
            readAt: now,
          });
          continue;
        }
        const ownMinor = availableMinor - heldMinor;
        const level: CollectReserveLevel =
          heldMinor > 0n && ownMinor < 0n
            ? 'broken'
            : availableMinor < 0n || ownMinor < levels.critical
              ? 'critical'
              : ownMinor < levels.warning
                ? 'warning'
                : 'ok';
        rows.push({ currency, availableMinor, heldMinor, ownMinor, level });
        const spell = {
          table: 'collect_reserve_readings' as const,
          provider,
          scope: currency,
          kind: sql`level = ${STORED_LEVEL[level]}`,
          fine: sql`level = 'ok'`,
        };
        const claim =
          level === 'ok'
            ? null
            : await claimReserveAlert(tx, {
                ...spell,
                currency,
                now,
              });
        const emailOwners =
          (level === 'critical' || level === 'broken') &&
          claim !== null &&
          !(await ownersEmailedInSpell(tx, spell));
        const readingId = newId();
        await tx.insert(collectReserveReadings).values({
          id: readingId,
          provider,
          currency,
          availableMinor,
          heldMinor,
          ownMinor,
          warningMinor: levels.warning,
          criticalMinor: levels.critical,
          level: STORED_LEVEL[level],
          readAt: now,
          alertClaimedAt: claim ? now : null,
        });
        if (level === 'broken')
          await openSpellIssue(tx, {
            kind: 'collect_invariant_broken',
            scope: currency,
            note: `${currency}: ${moneyText(availableMinor, currency)} available, ${moneyText(heldMinor, currency)} held for recipients (short by ${moneyText(-ownMinor, currency)}). New You collect sign-ups are paused until this is resolved.`,
            now,
          });
        if (level === 'critical')
          await openSpellIssue(tx, {
            kind: 'collect_reserve_low',
            scope: currency,
            note:
              availableMinor < 0n
                ? `TipMe's ${currency} balance is negative (${moneyText(availableMinor, currency)}): every transfer and withdrawal is blocked until it is topped up.`
                : `${currency}: TipMe's own money is ${moneyText(ownMinor, currency)}, below the ${moneyText(levels.critical, currency)} critical level.`,
            now,
          });
        if (claim)
          pending.push({
            table: 'collect_reserve_readings',
            rowId: readingId,
            level: level === 'warning' ? 'warning' : 'critical',
            text: alertText({
              provider,
              currency,
              level,
              availableMinor,
              heldMinor,
              ownMinor,
              levels,
            }),
            claimed: true,
            emailOwners,
          });
      }

      // The platform-wide conditions, one row each per check, so a spell starts and ends as a
      // currency's does: claimed alerts with the 6-hour repeat, owners emailed once per spell.
      const conditions: {
        condition: Condition;
        active: boolean;
        detail: string | null;
        level: 'warning' | 'critical';
        email: boolean;
        text: string;
      }[] = [
        {
          condition: 'unlisted_negative',
          active: unlisted !== null,
          detail: unlisted,
          level: 'critical',
          email: true,
          text: `TipMe's ${unlisted ?? ''} balance at ${provider} is negative. Every transfer and withdrawal is blocked until it is topped up, and TipMe's balances can't be read until then, so payout fees and fee returns wait.`,
        },
        {
          condition: 'unreadable',
          active: balances === null && unlisted === null && anyHeld,
          detail: null,
          level: 'warning',
          email: false,
          text: `TipMe's balances at ${provider} could not be read while it holds money for recipients. Payout fees and fee returns wait until a reading succeeds. Check the provider and the worker.`,
        },
        {
          condition: 'auto_payout',
          active: autoPayoutOn === true && inUse,
          detail: null,
          level: 'critical',
          email: true,
          text: `Automatic payouts are on for TipMe's own balance at ${provider}. Turn them off in the partner dashboard now: money held for recipients could be paid out with TipMe's earnings.`,
        },
      ];
      for (const c of conditions) {
        const spell = {
          table: 'collect_reserve_alerts' as const,
          provider,
          scope: c.condition,
          kind: sql`active = true`,
          fine: sql`active = false`,
        };
        const claim = c.active
          ? await claimReserveAlert(tx, {
              ...spell,
              currency: c.condition,
              now,
            })
          : null;
        const emailOwners =
          c.email && claim !== null && !(await ownersEmailedInSpell(tx, spell));
        const rowId = newId();
        await tx.insert(collectReserveAlerts).values({
          id: rowId,
          provider,
          condition: c.condition,
          active: c.active,
          detail: c.detail,
          readAt: now,
          alertClaimedAt: claim ? now : null,
        });
        if (c.active && c.condition === 'unlisted_negative')
          await openSpellIssue(tx, {
            kind: 'collect_reserve_low',
            scope: 'unlisted',
            note: `TipMe's ${c.detail} balance is negative: every transfer and withdrawal is blocked until it is topped up.`,
            now,
          });
        if (c.active && c.condition === 'auto_payout')
          await openSpellIssue(tx, {
            kind: 'collect_auto_payout_on',
            scope: 'all',
            note: `Schedule: ${Object.entries(schedule ?? {})
              .map(
                ([currency, interval]) =>
                  `${currency.slice(0, 8)} ${String(interval).slice(0, 20)}`,
              )
              .join(', ')}.`,
            now,
          });
        if (claim)
          pending.push({
            table: 'collect_reserve_alerts',
            rowId,
            level: c.level,
            text: c.text,
            claimed: true,
            emailOwners,
          });
      }
      return { perCurrency: rows, pending };
    });

    for (const p of pending) {
      const table =
        p.table === 'collect_reserve_readings'
          ? collectReserveReadings
          : collectReserveAlerts;
      // The owners first and apart: their email never waits on, or depends on, the staff route.
      if (p.emailOwners) {
        const emailed = await i
          .emailOwners(p.text)
          .then(() => true)
          .catch(() => false);
        if (emailed)
          await db
            .update(table)
            .set({ ownersEmailedAt: now })
            .where(eq(table.id, p.rowId));
      }
      try {
        await i.alert(p.text, p.level);
      } catch {
        // Reason dropped on purpose (a webhook error can quote its address); the next check resends.
        await db
          .update(table)
          .set({ alertClaimedAt: null })
          .where(eq(table.id, p.rowId));
        continue;
      }
      await db
        .update(table)
        .set({ alertedAt: now })
        .where(eq(table.id, p.rowId));
    }
    return {
      perCurrency,
      autoPayoutOn,
      ...(balances === null ? { unreadable: true as const } : {}),
      ...(unlisted !== null ? { unlistedNegative: unlisted as string } : {}),
    };
  });
}

function alertText(i: {
  provider: string;
  currency: string;
  level: CollectReserveLevel;
  availableMinor: bigint;
  heldMinor: bigint;
  ownMinor: bigint;
  levels: { warning: bigint; critical: bigint };
}): string {
  const m = (v: bigint) => moneyText(v, i.currency);
  const where = `TipMe's ${i.currency} balance at ${i.provider}`;
  const figures = `${m(i.availableMinor)} available, ${m(i.heldMinor)} held for recipients, ${m(i.ownMinor)} TipMe's own`;
  switch (i.level) {
    case 'broken':
      return `You collect rule broken: ${where} is below what TipMe holds for recipients (${figures}; short by ${m(-i.ownMinor)}).${i.availableMinor < 0n ? ' The balance is negative, so every transfer and withdrawal is blocked.' : ''} New You collect sign-ups are paused and TipMe's own moves are refused. Top it up now.`;
    case 'critical':
      return i.availableMinor < 0n
        ? `${where} is negative (${m(i.availableMinor)}). Every transfer and withdrawal is blocked until it is topped up.`
        : `You collect reserve critical: ${where}: ${figures}, below the ${m(i.levels.critical)} critical level. TipMe's own withdrawals and refund absorption are refused until it is topped up.`;
    case 'warning':
      return `You collect reserve low: ${where}: ${figures}, below the ${m(i.levels.warning)} warning level. It pays refunds, dispute fees and payout fees: top it up.`;
    case 'ok':
      return '';
  }
}

/** Why a move of TipMe's own money must wait (m5): never "the reserve is empty" when it isn't. */
export type OwnMoneyRefusal =
  | { reason: 'short' }
  | { reason: 'unknown' }
  | { reason: 'unlisted_negative'; bucket: string };

/** A reading dated further ahead than this is a clock fault, never trusted (m7). */
const FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Whether TipMe may move `amountMinor` of its own money now (P10, R5), and if not, why. From the
 * latest reading in that currency and what is held now. With nothing held it never refuses: nothing
 * it moves can be a recipient's, so behaviour with You collect off is unchanged. Otherwise it needs
 * a known reading at most RESERVE_STALE_AFTER_MS old (and not dated ahead), and refuses when
 * own − amount would go below zero, or (a voluntary move: a refund TipMe absorbs) below the critical
 * level. An owed move (a payout fee TipMe pays, a fee it returns) is non-voluntary.
 */
export function ownMoneyRefusal(
  db: Database | Tx,
  i: {
    amountMinor: bigint;
    currency: string;
    voluntary: boolean;
    now?: Date;
  },
): Promise<OwnMoneyRefusal | null> {
  return guarded(async () => {
    const held = await heldTotal(db, i.currency);
    if (held <= 0n) return null;
    const now = i.now ?? new Date();
    const [reading] = await db
      .select({
        availableMinor: collectReserveReadings.availableMinor,
        readAt: collectReserveReadings.readAt,
      })
      .from(collectReserveReadings)
      .where(eq(collectReserveReadings.currency, i.currency))
      .orderBy(desc(collectReserveReadings.readAt))
      .limit(1);
    const usable =
      reading &&
      reading.availableMinor !== null &&
      now.getTime() - reading.readAt.getTime() <= RESERVE_STALE_AFTER_MS &&
      reading.readAt.getTime() - now.getTime() <= FUTURE_SKEW_MS;
    if (!usable) {
      // A negative balance in an unlisted currency refuses the whole read: name it (I4).
      const [unlisted] = await db
        .select({
          detail: collectReserveAlerts.detail,
          readAt: collectReserveAlerts.readAt,
        })
        .from(collectReserveAlerts)
        .where(eq(collectReserveAlerts.condition, 'unlisted_negative'))
        .orderBy(desc(collectReserveAlerts.readAt))
        .limit(1);
      return unlisted?.detail &&
        Math.abs(now.getTime() - unlisted.readAt.getTime()) <=
          RESERVE_STALE_AFTER_MS
        ? { reason: 'unlisted_negative', bucket: unlisted.detail }
        : { reason: 'unknown' };
    }
    const after = reading.availableMinor! - held - i.amountMinor;
    if (after < 0n) return { reason: 'short' };
    if (!i.voluntary) return null;
    const critical =
      i.currency === 'NGN'
        ? (await collectSettingsInForce(db, now)).reserveCriticalMinor
        : 0n;
    return after >= critical ? null : { reason: 'short' };
  });
}

/** ownMoneyRefusal as a yes or no. */
export async function ownMoneyAllows(
  db: Database | Tx,
  i: {
    amountMinor: bigint;
    currency: string;
    voluntary: boolean;
    now?: Date;
  },
): Promise<boolean> {
  return (await ownMoneyRefusal(db, i)) === null;
}

/** A refusal in staff words, for the wait's issue. */
export function ownMoneyRefusalWords(refusal: OwnMoneyRefusal): string {
  switch (refusal.reason) {
    case 'short':
      return "Why: TipMe's own money at the partner, above what it holds for recipients, can't cover it. Top up TipMe's balance.";
    case 'unknown':
      return "Why: no recent reading of TipMe's balance at the partner, so its own money can't be confirmed. Check that the reserve check is running and that the balance can be read.";
    case 'unlisted_negative':
      return `Why: TipMe's ${refusal.bucket} balance at the partner is negative, which blocks reading every balance. Top up ${refusal.bucket}.`;
  }
}

/** You collect sign-ups pause while the rule is broken: an open `collect_invariant_broken` issue. */
export async function collectSignupsPaused(
  db: Database | Tx,
): Promise<boolean> {
  const [open] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.kind, 'collect_invariant_broken'),
        eq(issues.status, 'open'),
      ),
    )
    .limit(1);
  return Boolean(open);
}

/**
 * Review m9: readings that said nothing was wrong, and conditions that weren't active, are kept as
 * long as today's reserve readings (RESERVE_KEEP_MS), then purged. Rows of a spell that is still
 * going are never `ok` or inactive, so the 6-hour rule and the owners' email mark are kept.
 */
export function purgeCollectReserveRows(
  db: Database,
  input: { before: Date },
): Promise<number> {
  return guarded(async () => {
    const readings = await db.execute(sql`
      DELETE FROM collect_reserve_readings
       WHERE level = 'ok' AND read_at < ${input.before.toISOString()}::timestamptz`);
    const alerts = await db.execute(sql`
      DELETE FROM collect_reserve_alerts
       WHERE active = false AND read_at < ${input.before.toISOString()}::timestamptz`);
    return (readings.rowCount ?? 0) + (alerts.rowCount ?? 0);
  });
}
