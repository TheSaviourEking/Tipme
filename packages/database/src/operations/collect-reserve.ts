import { and, desc, eq, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import { collectReserveReadings, issues, type IssueKind } from '../schema.js';
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

interface Claimed {
  readingId: string;
  level: CollectReserveLevel;
  first: boolean;
  text: string;
}

/**
 * One reserve check of TipMe's own money (see the header). The partner reads and the alert and email
 * calls are never made under the lock. A send that fails gives its claim back, so the next check
 * sends it; owners are emailed with a spell's first critical or broken alert.
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
    // A failed read is a normal answer ("unknown"); its error is never kept: it may carry details.
    const balances = await i.provider.platformBalances().catch(() => null);
    const schedule = await i.provider
      .platformPayoutSchedule()
      .catch(() => null);
    const autoPayoutOn = schedule
      ? Object.values(schedule).some((interval) => interval !== 'manual')
      : null;
    const settings = await collectSettingsInForce(db, now);

    const { perCurrency, claimed, autoAlert } = await db.transaction(
      async (tx) => {
        await tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${`${IN_FLIGHT_LOCK}:${provider}`}::text))`,
        );
        // Read under the lock, so a reading's held total is the one its level was decided on.
        const held = await heldTotals(tx);
        const inUse = await collectInUse(tx, held);
        const currencies = new Set<string>(
          [...held.entries()].filter(([, v]) => v > 0n).map(([c]) => c),
        );
        for (const b of balances ?? []) currencies.add(b.currency);
        const rows: CollectReserveResult['perCurrency'] = [];
        const claims: Claimed[] = [];
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
          const claim =
            level === 'ok'
              ? null
              : await claimReserveAlert(tx, {
                  table: 'collect_reserve_readings',
                  provider,
                  currency,
                  kind: sql`level = ${STORED_LEVEL[level]}`,
                  fine: sql`level = 'ok'`,
                  now,
                });
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
          const text = alertText({
            provider,
            currency,
            level,
            availableMinor,
            heldMinor,
            ownMinor,
            levels,
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
            claims.push({ readingId, level, first: claim === 'first', text });
        }
        const autoAlert =
          autoPayoutOn === true && inUse
            ? await openSpellIssue(tx, {
                kind: 'collect_auto_payout_on',
                scope: 'all',
                note: `Schedule: ${Object.entries(schedule ?? {})
                  .map(
                    ([currency, interval]) =>
                      `${currency.slice(0, 8)} ${String(interval).slice(0, 20)}`,
                  )
                  .join(', ')}.`,
                now,
              })
            : false;
        return { perCurrency: rows, claimed: claims, autoAlert };
      },
    );

    for (const claim of claimed) {
      try {
        await i.alert(
          claim.text,
          claim.level === 'warning' ? 'warning' : 'critical',
        );
      } catch {
        // Reason dropped on purpose (a webhook error can quote its address); the next check resends.
        await db
          .update(collectReserveReadings)
          .set({ alertClaimedAt: null })
          .where(eq(collectReserveReadings.id, claim.readingId));
        continue;
      }
      await db
        .update(collectReserveReadings)
        .set({ alertedAt: now })
        .where(eq(collectReserveReadings.id, claim.readingId));
      if (claim.level !== 'warning' && claim.first)
        await i.emailOwners(claim.text).catch(() => undefined);
    }
    if (autoAlert)
      await i
        .alert(
          `Automatic payouts are on for TipMe's own balance at ${provider}. Turn them off in the partner dashboard now: money held for recipients could be paid out with TipMe's earnings.`,
          'critical',
        )
        .catch(() => undefined);
    return {
      perCurrency,
      autoPayoutOn,
      ...(balances === null ? { unreadable: true as const } : {}),
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
      return `You collect rule broken: ${where} is below what TipMe holds for recipients (${figures}; short by ${m(-i.ownMinor)}). New You collect sign-ups are paused and TipMe's own moves are refused. Top it up now.`;
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

/**
 * Whether TipMe may move `amountMinor` of its own money now (P10, R5), from the latest reading in
 * that currency and what is held now. With nothing held it never refuses: nothing it moves can be a
 * recipient's, so behaviour with You collect off is unchanged. Otherwise it needs a fresh, known
 * reading, and refuses when own − amount would go below zero, or (a voluntary move: a refund TipMe
 * absorbs, its own withdrawal) below the critical level. An owed move (a payout fee TipMe pays, a fee
 * it returns) is non-voluntary.
 */
export function ownMoneyAllows(
  db: Database | Tx,
  i: {
    amountMinor: bigint;
    currency: string;
    voluntary: boolean;
    now?: Date;
  },
): Promise<boolean> {
  return guarded(async () => {
    const held = await heldTotal(db, i.currency);
    if (held <= 0n) return true;
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
    if (!reading || reading.availableMinor === null) return false;
    if (now.getTime() - reading.readAt.getTime() > RESERVE_STALE_AFTER_MS)
      return false;
    const after = reading.availableMinor - held - i.amountMinor;
    if (after < 0n) return false;
    if (!i.voluntary) return true;
    const critical =
      i.currency === 'NGN'
        ? (await collectSettingsInForce(db, now)).reserveCriticalMinor
        : 0n;
    return after >= critical;
  });
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
