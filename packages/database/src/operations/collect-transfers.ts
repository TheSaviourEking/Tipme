import { bachsEnvironment, recordedProviderName } from '@tipme/contracts';
import {
  buildCollectTransferPosting,
  canTransition,
  COLLECT_TRANSFER_TRANSITIONS,
  type CollectTransferStatus,
} from '@tipme/domain';
import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  collectTransfers,
  issues,
  paymentAttempts,
  paymentIntents,
  profiles,
  tipQuotes,
} from '../schema.js';
import { collectSettingsInForce } from './collect-settings.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';
import { postLedgerTransaction } from './ledger.js';

/*
 * You collect (spec §5, §8; plan Task 7). A collect tip's net is held on TipMe's own partner account
 * (`held_for_recipients`) and moved on to the recipient's account by one `share` transfer per tip.
 * The payment's own transaction schedules that transfer here; the machine below (Task 8) sends it:
 * claim, send, read back by `transfer_group`.
 */

/** The share transfer's key, which is also its `transfer_group` at the partner. */
export const collectKey = (tipId: string) => `tipme-collect-${tipId}`;

/**
 * Called with the collect payment's posting, in its transaction: the tip's one `share` row, waiting
 * for the recipient's verified account (filled when it moves to `ready`, P8). Its `release_after` is
 * the new-recipient delay (§8): `settledAt + delay_hours` while the profile is younger than
 * `delay_for_days` at `settledAt`, otherwise `settledAt`. Once per tip (the key and the one-share
 * index), so a repeat delivery inserts nothing.
 *
 * `environment` is the partner environment the tip was paid in (TipMe's copies run one environment
 * each, but the row says which). The pretend provider's tips are `sandbox`.
 */
export async function scheduleCollectTransfer(
  tx: Tx,
  i: {
    tipId: string;
    profileId: string;
    amountMinor: bigint;
    currency: string;
    provider: string;
    chargeReference: string | null;
    settledAt: Date;
    environment: 'sandbox' | 'live';
  },
): Promise<void> {
  const { environment } = i;
  if (i.amountMinor <= 0n) return;
  const settings = await collectSettingsInForce(tx, i.settledAt);
  const [profile] = await tx
    .select({ createdAt: profiles.createdAt })
    .from(profiles)
    .where(eq(profiles.id, i.profileId));
  if (!profile) throw new Error('a collect transfer needs its recipient');
  const newUntil =
    profile.createdAt.getTime() + settings.delayForDays * 24 * 3_600_000;
  const releaseAfter =
    i.settledAt.getTime() < newUntil
      ? new Date(i.settledAt.getTime() + settings.delayHours * 3_600_000)
      : i.settledAt;
  await tx
    .insert(collectTransfers)
    .values({
      id: newId(),
      kind: 'share',
      tipId: i.tipId,
      profileId: i.profileId,
      provider: i.provider,
      environment,
      amountMinor: i.amountMinor,
      currency: i.currency,
      status: 'waiting',
      idempotencyKey: collectKey(i.tipId),
      chargeReference: i.chargeReference,
      releaseAfter,
      // Due from settlement, on the caller's clock (the sweep's capability backoff moves it on).
      nextTryAt: i.settledAt,
    })
    .onConflictDoNothing();
}

const PLATFORM_CHECKOUT = /^platform:[^:]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * R2: the collect payment attempt a platform-scoped (TipMe's own account) event is about, or null.
 * Matched by TipMe's own reference (the attempt id, which the collect checkout sends), then by the
 * checkout (`platform:<checkout_id>`, the attempt's provider reference), then by the partner's charge
 * stored on the tip's share transfer. Only an attempt quoted `collect` on the partner (never the
 * pretend provider) can match, so a Pro purchase's event never reaches a tip; an event that matches
 * nothing goes on to Pro billing.
 */
export function matchCollectAttempt(
  db: Database,
  i: {
    providerReference: string | null;
    operationReference: string | null;
    chargeReference: string | null;
  },
): Promise<string | null> {
  return guarded(async () => {
    const byOperation =
      i.operationReference && UUID.test(i.operationReference)
        ? i.operationReference.toLowerCase()
        : null;
    const byCheckout =
      i.providerReference && PLATFORM_CHECKOUT.test(i.providerReference)
        ? i.providerReference
        : null;
    const byCharge = i.chargeReference || null;
    if (!byOperation && !byCheckout && !byCharge) return null;
    // Which reference matched: TipMe's own first, then the checkout, then the charge.
    const rank = sql<number>`CASE
      WHEN ${paymentAttempts.id}::text = ${byOperation} THEN 1
      WHEN ${paymentAttempts.providerReference} = ${byCheckout} THEN 2
      ELSE 3 END`;
    const rows = await db
      .select({ id: paymentAttempts.id, rank })
      .from(paymentAttempts)
      .innerJoin(
        paymentIntents,
        eq(paymentIntents.id, paymentAttempts.intentId),
      )
      .innerJoin(tipQuotes, eq(tipQuotes.id, paymentIntents.quoteId))
      .where(
        and(
          eq(tipQuotes.collectionMode, 'collect'),
          or(
            isNull(paymentAttempts.provider),
            eq(paymentAttempts.provider, 'bachs'),
          ),
          or(
            byOperation
              ? sql`${paymentAttempts.id}::text = ${byOperation}`
              : undefined,
            byCheckout
              ? eq(paymentAttempts.providerReference, byCheckout)
              : undefined,
            byCharge
              ? and(
                  eq(paymentAttempts.status, 'VERIFIED_SUCCEEDED'),
                  sql`EXISTS (
                    SELECT 1 FROM collect_transfers c JOIN tips t ON t.id = c.tip_id
                     WHERE t.intent_id = ${paymentAttempts.intentId} AND c.kind = 'share'
                       AND c.charge_reference = ${byCharge})`,
                )
              : undefined,
          ),
        ),
      )
      .orderBy(rank, paymentAttempts.id)
      .limit(2);
    const [first, second] = rows;
    // Two attempts for one charge would be a bug: neither is guessed.
    if (!first || (second && second.rank === first.rank)) return null;
    return first.id;
  });
}

/*
 * The transfer machine (plan Task 8, spec §5, R9–R11). One `share` row per tip:
 *
 *   waiting ──release──▶ ready ──claim──▶ sent ──▶ paid
 *                          ▲               ├──▶ ready     (insufficient balance: backoff; in debt)
 *                          │               ├──▶ waiting   (the recipient's capability is gone)
 *                          │               ├──▶ review    (not found, another refusal, another amount)
 *                          │               └──▶ unknown ──same key (24 h) / read back──▶ paid | ready
 *
 * Exactly once: the claim (`ready → sent`) is a conditional update committed before the partner is
 * called, so of any number of workers one sends. Every later move is conditional on the state it
 * leaves. The key is always `tipme-collect-<tipId>` (also the `transfer_group`). An answer that was
 * lost is asked again with that key while the partner still knows it (SAME_KEY_WITHIN_MS from the
 * first send of the key), and read back by `transfer_group` after that. Never a new key, never a
 * blind send after the window. `sent_at` is when the key was first sent in its current window.
 */

/** A claimed row whose worker gave no word for this long is read back. */
export const READ_BACK_AFTER_MS = 2 * 60_000;
/** How long the partner replays a key (its idempotency window). */
export const SAME_KEY_WITHIN_MS = 24 * 3_600_000;
/** A share ready (and tried) for longer than this raises `collect_transfer_stuck`. */
const STUCK_AFTER_MS = 3_600_000;
const PER_RECIPIENT_PER_RUN = 5;
const RUN_LIMIT = 100;
/** The pretend provider has no partner accounts: a recipient's account is their profile id. */
const PRETEND_PROVIDER = 'mock';

/** The partner calls the machine needs (Task 4's adapter and the mock). Structural, as ADR-0004. */
export interface CollectTransferProvider {
  name: string;
  sendCollectTransfer(input: {
    accountRef: string;
    amountMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
  }): Promise<{ transferRef: string; status: 'paid' | 'pending' }>;
  listAccountTransfers(accountRef: string): Promise<
    {
      transferRef: string;
      status: 'paid' | 'pending';
      amountMinor: bigint;
      currency: string;
      group: string | null;
    }[]
  >;
  payoutCapability(
    accountRef: string,
  ): Promise<{ status: 'active' | 'restricted' | 'missing' }>;
}

export interface CollectTransferRun {
  sent: number;
  paid: number;
  retried: number;
  review: number;
  /**
   * Why the run stopped early: staff's pause, TipMe's account in debt (R11), or a FORBIDDEN that
   * was TipMe's own (its key, not the recipient's account).
   */
  stopped?: 'paused' | 'in_debt' | 'platform';
}

type Row = typeof collectTransfers.$inferSelect;
type Insert = typeof collectTransfers.$inferInsert;
/** Columns to set: a value, or SQL computed from the row itself. */
type RowSet = { [K in keyof Insert]?: Insert[K] | SQL };
type Status = CollectTransferStatus;
type Stop = 'in_debt' | 'platform';
type Outcome = 'paid' | 'retried' | 'review' | 'none' | { stop: Stop };

/** Waits after insufficient balance or a lost capability: 5 minutes, doubling, at most 6 hours. */
function backoff(attempts: number, now: Date): Date {
  const minutes = Math.min(5 * 2 ** Math.max(0, attempts - 1), 360);
  return new Date(now.getTime() + minutes * 60_000);
}

/** After a lost answer: READ_BACK_AFTER_MS, doubling with each send, at most 6 hours. */
function unknownWait(attempts: number, now: Date): Date {
  const ms = Math.min(
    READ_BACK_AFTER_MS * 2 ** Math.max(0, attempts - 1),
    6 * 3_600_000,
  );
  return new Date(now.getTime() + ms);
}

/**
 * The refusal the adapter raises when the partner definitely refused (no money moved). Read by
 * shape: the payments package's types stay in it (ADR-0004).
 */
function refusalOf(
  error: unknown,
): 'insufficient' | 'capability' | 'in_debt' | 'not_found' | 'other' | null {
  if (!(error instanceof Error) || error.name !== 'CollectTransferRefusedError')
    return null;
  const reason = (error as { reason?: unknown }).reason;
  return reason === 'insufficient' ||
    reason === 'capability' ||
    reason === 'in_debt' ||
    reason === 'not_found'
    ? reason
    : 'other';
}

/**
 * A conditional move: only from `from` and only as this worker last saw the row (its `attempts`,
 * which every claim raises), and for a claim only once due. So of any number of workers exactly one
 * gets it, and a slow read-back can never move a row someone has claimed since. The transition
 * must be one R10 allows. Returns the row as moved, or null.
 */
async function move(
  db: Database | Tx,
  row: Pick<Row, 'id' | 'attempts'>,
  from: Status,
  to: Status,
  now: Date,
  set: RowSet = {},
  due = false,
): Promise<Row | null> {
  if (from !== to && !canTransition(COLLECT_TRANSFER_TRANSITIONS, from, to))
    throw new Error(`a collect transfer can't go from ${from} to ${to}`);
  const [moved] = await db
    .update(collectTransfers)
    .set({ ...set, status: to, updatedAt: now })
    .where(
      and(
        eq(collectTransfers.id, row.id),
        eq(collectTransfers.status, from),
        eq(collectTransfers.attempts, row.attempts),
        ...(due ? [lte(collectTransfers.nextTryAt, now)] : []),
      ),
    )
    .returning();
  return moved ?? null;
}

/**
 * Waiting shares whose recipient can receive them now become `ready` (spec §5): the recipient is
 * verified (bank details checked, `transfers` active when verified, Task 13), their bank is
 * `usable`, the new-recipient delay has passed, and nothing holds them (a shared bank account in
 * review, an open dispute on the tip). The account is read at this moment, from the recipient's
 * current account (P8), never earlier. A share sent back to waiting because the recipient's
 * capability was gone waits out its backoff before the sweep tries it again; a caller naming a
 * profile has just read that account as able to receive (`capability.updated`, verification), so
 * for that profile the backoff is skipped. Returns how many were released.
 */
export function releaseWaitingTransfers(
  db: Database,
  i: { profileId?: string; now: Date },
): Promise<number> {
  return guarded(async () => {
    const now = i.now.toISOString();
    const result = await db.execute<{ id: string }>(sql`
      UPDATE collect_transfers c
         SET status = 'ready', account_reference = a.reference, next_try_at = ${now}::timestamptz,
             updated_at = ${now}::timestamptz
        FROM (
          SELECT w.id,
                 COALESCE(pa.provider_account_reference,
                          CASE WHEN w.provider = ${PRETEND_PROVIDER} THEN w.profile_id::text END) AS reference
            FROM collect_transfers w
            JOIN profiles p ON p.id = w.profile_id
            LEFT JOIN payment_accounts pa
              ON pa.profile_id = w.profile_id AND pa.provider = w.provider
             AND pa.environment = w.environment
           WHERE w.status = 'waiting' AND w.kind = 'share'
             AND (w.release_after IS NULL OR w.release_after <= ${now}::timestamptz)
             AND ${i.profileId ? sql`w.profile_id = ${i.profileId}` : sql`w.next_try_at <= ${now}::timestamptz`}
             AND p.collect_verified_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM payout_destinations d
                WHERE d.profile_id = w.profile_id AND d.provider = w.provider
                  AND d.replaced_at IS NULL AND d.status = 'usable')
             AND NOT EXISTS (
               SELECT 1 FROM collect_transfers r
                WHERE r.profile_id = w.profile_id AND r.status = 'review'
                  AND r.review_reason = 'same_bank')
             AND NOT EXISTS (
               SELECT 1 FROM disputes x
                WHERE x.tip_id = w.tip_id AND x.status IN ('open', 'responded'))
        ) a
       WHERE c.id = a.id AND c.status = 'waiting' AND a.reference IS NOT NULL
      RETURNING c.id`);
    return result.rows.length;
  });
}

/**
 * One open issue at a time for a platform-wide condition, however many workers and rows run into
 * it. Each spell gets its own key (`<prefix><id>`): a closed issue must never swallow the next one.
 */
async function openOnce(
  tx: Tx,
  input: {
    prefix: string;
    kind:
      'collect_in_debt' | 'collect_transfer_stuck' | 'collect_transfer_review';
    subject: { tipId?: string; profileId?: string };
    note: string;
    now: Date;
  },
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`collect_issue:${input.prefix}`}::text))`,
  );
  const [open] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.status, 'open'),
        sql`starts_with(${issues.dedupeKey}, ${input.prefix})`,
      ),
    )
    .limit(1);
  if (open) return;
  await openIssue(tx, {
    dedupeKey: `${input.prefix}${newId()}`,
    kind: input.kind,
    subject: input.subject,
    note: input.note,
    now: input.now,
  });
}

const DEBT_PREFIX = 'collect_in_debt.';
const PLATFORM_PREFIX = 'collect_transfer_stuck.platform.';
const STUCK_PREFIX = 'collect_transfer_stuck.ready.';

/** R11: an open `collect_in_debt` issue stops every collect transfer until staff resolve it. */
async function frozenByDebt(db: Database): Promise<boolean> {
  const [open] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.kind, 'collect_in_debt'), eq(issues.status, 'open')))
    .limit(1);
  return Boolean(open);
}

/** The partner moved it: paid, and the held money booked as moved, in one transaction. */
async function finishPaid(
  db: Database,
  row: Row,
  from: 'sent' | 'unknown',
  transferRef: string,
  now: Date,
): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const paid = await move(tx, row, from, 'paid', now, {
      transferReference: transferRef,
      paidAt: now,
    });
    if (!paid) return 'none';
    await postLedgerTransaction(tx, {
      operationType: 'collect_transfer',
      operationKey: `collect_transfer.${row.id}`,
      currency: row.currency,
      tipId: row.tipId,
      traceId: null,
      lines: buildCollectTransferPosting({
        amountMinor: row.amountMinor,
        profileId: row.profileId,
      }),
    });
    return 'paid';
  });
}

/** A person needs to look (P13 `provider`): TipMe may hold money it could not send. Nothing is sent. */
async function toReview(
  db: Database,
  row: Row,
  from: Status,
  now: Date,
  note: string,
): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const held = await move(tx, row, from, 'review', now, {
      reviewReason: 'provider',
    });
    if (!held) return 'none';
    await openIssue(tx, {
      dedupeKey: `collect_transfer_review.${row.id}`,
      kind: 'collect_transfer_review',
      subject: { tipId: row.tipId, profileId: row.profileId },
      note: `${note} Transfer ${row.id}, group ${row.idempotencyKey}.`,
      now,
    });
    return 'review';
  });
}

/** Sends a `ready` row: the claim first, committed, then the one partner call. */
async function send(
  db: Database,
  row: Row,
  provider: CollectTransferProvider,
  now: Date,
  totals: CollectTransferRun,
): Promise<Outcome> {
  const accountRef = row.accountReference;
  if (!accountRef || row.currency !== 'NGN')
    return toReview(
      db,
      row,
      'ready',
      now,
      'This share names no account, or a currency the partner cannot send.',
    );
  const windowFrom = new Date(now.getTime() - SAME_KEY_WITHIN_MS);
  const claimed = await move(
    db,
    row,
    'ready',
    'sent',
    now,
    {
      attempts: sql`${collectTransfers.attempts} + 1`,
      // The key's window at the partner: kept while it lasts, started again once it is over.
      sentAt: sql`CASE WHEN ${collectTransfers.sentAt} > ${windowFrom} THEN ${collectTransfers.sentAt} ELSE ${now} END`,
    },
    true,
  );
  if (!claimed) return 'none';
  totals.sent += 1;
  let answer: { transferRef: string; status: 'paid' | 'pending' };
  try {
    answer = await provider.sendCollectTransfer({
      accountRef,
      amountMinor: claimed.amountMinor,
      currency: 'NGN',
      idempotencyKey: claimed.idempotencyKey,
    });
  } catch (error) {
    return refused(db, claimed, provider, accountRef, now, error);
  }
  if (answer.status === 'paid')
    return finishPaid(db, claimed, 'sent', answer.transferRef, now);
  // Pending at the partner: read back once its worker's turn is over.
  await move(db, claimed, 'sent', 'sent', now, {
    transferReference: answer.transferRef,
  });
  return 'none';
}

/** What a failed send means. Only a definite refusal proves no money moved. */
async function refused(
  db: Database,
  row: Row,
  provider: CollectTransferProvider,
  accountRef: string,
  now: Date,
  error: unknown,
): Promise<Outcome> {
  const reason = refusalOf(error);
  if (reason === null) {
    // It may have moved: the same key later (inside the window), or a read-back after it.
    await move(db, row, 'sent', 'unknown', now, {
      nextTryAt: unknownWait(row.attempts, now),
    });
    return 'retried';
  }
  if (reason === 'insufficient') {
    // TipMe's available balance doesn't hold it yet (§5): the same key later.
    await move(db, row, 'sent', 'ready', now, {
      nextTryAt: backoff(row.attempts, now),
    });
    return 'retried';
  }
  if (reason === 'in_debt') {
    // R11: TipMe's own account is in debt. Every collect transfer stops behind one issue.
    await db.transaction(async (tx) => {
      await move(tx, row, 'sent', 'ready', now, { nextTryAt: now });
      await openOnce(tx, {
        prefix: DEBT_PREFIX,
        kind: 'collect_in_debt',
        subject: {},
        note: `The partner answered ORGANIZATION_IN_DEBT to transfer ${row.id}. Nothing moved.`,
        now,
      });
    });
    return { stop: 'in_debt' };
  }
  if (reason === 'capability') {
    // FORBIDDEN is the recipient's account only if the account says so: it can also be TipMe's
    // own key without `transfers:write` (Task 4 review).
    let status: 'active' | 'restricted' | 'missing' | null = null;
    try {
      ({ status } = await provider.payoutCapability(accountRef));
    } catch {
      status = null;
    }
    if (status === null) {
      await move(db, row, 'sent', 'ready', now, {
        nextTryAt: backoff(row.attempts, now),
      });
      return 'retried';
    }
    if (status === 'active') {
      await db.transaction(async (tx) => {
        await move(tx, row, 'sent', 'ready', now, {
          nextTryAt: backoff(row.attempts, now),
        });
        await openOnce(tx, {
          prefix: PLATFORM_PREFIX,
          kind: 'collect_transfer_stuck',
          subject: {},
          note: `The partner refused transfer ${row.id} as FORBIDDEN, yet the recipient's account can receive transfers: TipMe's own key may have lost transfers:write. Every collect transfer stops at the first such refusal; nothing moved.`,
          now,
        });
      });
      return { stop: 'platform' };
    }
    // The recipient's account can't receive now: this share and their other ready ones wait for
    // `capability.updated` (or the backoff), the account read deciding.
    const nextTryAt = backoff(row.attempts, now);
    await db.transaction(async (tx) => {
      await move(tx, row, 'sent', 'waiting', now, { nextTryAt });
      await tx
        .update(collectTransfers)
        .set({ status: 'waiting', nextTryAt, updatedAt: now })
        .where(
          and(
            eq(collectTransfers.profileId, row.profileId),
            eq(collectTransfers.provider, row.provider),
            eq(collectTransfers.environment, row.environment),
            eq(collectTransfers.kind, 'share'),
            eq(collectTransfers.status, 'ready'),
          ),
        );
    });
    return 'retried';
  }
  return toReview(
    db,
    row,
    'sent',
    now,
    reason === 'not_found'
      ? 'The partner answered NOT_FOUND: it does not know the account. Nothing moved.'
      : 'The partner refused it for another reason. Nothing moved.',
  );
}

/**
 * Looks for the row's transfer at the partner by its group. Found with the right money: paid.
 * Found otherwise (another amount, or two in one group): review. Pending: looked at again later.
 * Not found: sent again with the same key. A list that can't be read proves nothing.
 */
async function readBack(
  db: Database,
  row: Row,
  from: 'sent' | 'unknown',
  provider: CollectTransferProvider,
  now: Date,
  totals: CollectTransferRun,
): Promise<Outcome> {
  const accountRef = row.accountReference;
  if (!accountRef) return 'none';
  let listed: Awaited<
    ReturnType<CollectTransferProvider['listAccountTransfers']>
  >;
  try {
    listed = await provider.listAccountTransfers(accountRef);
  } catch {
    await move(db, row, from, 'unknown', now, {
      nextTryAt: unknownWait(row.attempts, now),
    });
    return 'retried';
  }
  const ours = listed.filter((t) => t.group === row.idempotencyKey);
  const [found] = ours;
  if (
    ours.length > 1 ||
    (found &&
      (found.amountMinor !== row.amountMinor ||
        found.currency !== row.currency))
  )
    return toReview(
      db,
      row,
      from,
      now,
      'The partner shows this transfer with another amount or currency, or more than one in its group.',
    );
  if (found?.status === 'paid')
    return finishPaid(db, row, from, found.transferRef, now);
  if (found) {
    await move(db, row, from, from, now, {
      transferReference: found.transferRef,
      nextTryAt: unknownWait(row.attempts, now),
    });
    return 'none';
  }
  // Nothing moved under this key: the same key again (the claim starts a new window if it's over).
  const again = await move(db, row, from, 'ready', now, { nextTryAt: now });
  if (!again) return 'none';
  return send(db, again, provider, now, totals);
}

/** A claimed row nobody answered for, or a lost answer due another try. */
async function resolveInFlight(
  db: Database,
  row: Row,
  provider: CollectTransferProvider,
  now: Date,
  totals: CollectTransferRun,
): Promise<Outcome> {
  if (row.status === 'sent')
    return readBack(db, row, 'sent', provider, now, totals);
  const inWindow =
    row.sentAt !== null &&
    now.getTime() - row.sentAt.getTime() < SAME_KEY_WITHIN_MS;
  if (!inWindow) return readBack(db, row, 'unknown', provider, now, totals);
  // Inside the partner's window: the same key replays a transfer that moved, or makes the one.
  const again = await move(db, row, 'unknown', 'ready', now, {
    nextTryAt: now,
  });
  if (!again) return 'none';
  return send(db, again, provider, now, totals);
}

/** One open `collect_transfer_stuck` while any share has been ready, and tried, for over an hour. */
async function raiseStuck(
  db: Database,
  provider: { name: string; environment: 'sandbox' | 'live' },
  now: Date,
): Promise<void> {
  const before = new Date(now.getTime() - STUCK_AFTER_MS);
  const stuck = await db
    .select({
      id: collectTransfers.id,
      tipId: collectTransfers.tipId,
      profileId: collectTransfers.profileId,
    })
    .from(collectTransfers)
    .where(
      and(
        eq(collectTransfers.provider, provider.name),
        eq(collectTransfers.environment, provider.environment),
        eq(collectTransfers.status, 'ready'),
        lte(collectTransfers.sentAt, before),
      ),
    )
    .orderBy(asc(collectTransfers.sentAt), asc(collectTransfers.id))
    .limit(RUN_LIMIT);
  const [oldest] = stuck;
  if (!oldest) return;
  await db.transaction((tx) =>
    openOnce(tx, {
      prefix: STUCK_PREFIX,
      kind: 'collect_transfer_stuck',
      subject: { tipId: oldest.tipId, profileId: oldest.profileId },
      note: `${stuck.length >= RUN_LIMIT ? `${RUN_LIMIT} or more` : stuck.length} share(s) are waiting; the oldest is transfer ${oldest.id}.`,
      now,
    }),
  );
}

/**
 * One run of the machine for one provider (every 2 minutes, `collect.transfers`). Staff's pause and
 * an open `collect_in_debt` issue stop it before anything is asked. Claimed rows with no answer and
 * lost answers come first, then ready shares: at most `perRecipientPerRun` per recipient, oldest
 * tip first. The first in-debt answer (or a FORBIDDEN that is TipMe's own) stops the run.
 */
export async function runCollectTransfers(
  db: Database,
  i: {
    provider: CollectTransferProvider;
    now: Date;
    limit?: number;
    perRecipientPerRun?: number;
  },
): Promise<CollectTransferRun> {
  const { provider, now } = i;
  const totals: CollectTransferRun = {
    sent: 0,
    paid: 0,
    retried: 0,
    review: 0,
  };
  const settings = await guarded(() => collectSettingsInForce(db, now));
  if (settings.paused) return { ...totals, stopped: 'paused' };
  if (await guarded(() => frozenByDebt(db)))
    return { ...totals, stopped: 'in_debt' };
  const scope = {
    name: recordedProviderName(provider.name),
    environment: bachsEnvironment(provider.name) ?? ('sandbox' as const),
  };
  const limit = i.limit ?? RUN_LIMIT;
  const perRecipient = i.perRecipientPerRun ?? PER_RECIPIENT_PER_RUN;
  const readBackBefore = new Date(now.getTime() - READ_BACK_AFTER_MS);
  const inScope = and(
    eq(collectTransfers.provider, scope.name),
    eq(collectTransfers.environment, scope.environment),
    eq(collectTransfers.kind, 'share'),
  );
  const inFlight = await guarded(() =>
    db
      .select()
      .from(collectTransfers)
      .where(
        and(
          inScope,
          or(
            and(
              eq(collectTransfers.status, 'sent'),
              lte(collectTransfers.updatedAt, readBackBefore),
            ),
            and(
              eq(collectTransfers.status, 'unknown'),
              lte(collectTransfers.nextTryAt, now),
            ),
          ),
        ),
      )
      .orderBy(asc(collectTransfers.createdAt), asc(collectTransfers.id))
      .limit(limit),
  );
  const ranked = await guarded(() =>
    db.execute<{ id: string }>(sql`
      SELECT id FROM (
        SELECT c.id, t.created_at AS tip_at,
               row_number() OVER (PARTITION BY c.profile_id ORDER BY t.created_at, c.id) AS n
          FROM collect_transfers c JOIN tips t ON t.id = c.tip_id
         WHERE c.provider = ${scope.name} AND c.environment = ${scope.environment}
           AND c.kind = 'share' AND c.status = 'ready'
           AND c.next_try_at <= ${now.toISOString()}::timestamptz
      ) r
       WHERE n <= ${perRecipient}
       ORDER BY tip_at, id
       LIMIT ${limit}`),
  );
  const readyIds = ranked.rows.map((r) => r.id);
  const readyRows = readyIds.length
    ? await guarded(() =>
        db
          .select()
          .from(collectTransfers)
          .where(inArray(collectTransfers.id, readyIds)),
      )
    : [];
  const byId = new Map(readyRows.map((row) => [row.id, row]));
  const work: { row: Row; step: 'resolve' | 'send' }[] = [
    ...inFlight.map((row) => ({ row, step: 'resolve' as const })),
    ...readyIds.flatMap((id) => {
      const row = byId.get(id);
      return row ? [{ row, step: 'send' as const }] : [];
    }),
  ];
  for (const { row, step } of work) {
    let outcome: Outcome;
    try {
      outcome = await guarded(() =>
        step === 'resolve'
          ? resolveInFlight(db, row, provider, now, totals)
          : send(db, row, provider, now, totals),
      );
    } catch {
      // One row's trouble never stops the others; it is due again next run.
      continue;
    }
    if (typeof outcome === 'object')
      return { ...totals, stopped: outcome.stop };
    if (outcome !== 'none') totals[outcome] += 1;
  }
  await guarded(() => raiseStuck(db, scope, now));
  return totals;
}

/**
 * Staff hold a share for a manual check (P13 `staff`). Only one that hasn't been sent: a share in
 * flight (`sent`, `unknown`) is never held by hand, since its money may be moving.
 */
export function holdCollectTransfer(
  db: Database,
  i: { transferId: string; now: Date },
): Promise<boolean> {
  return guarded(async () => {
    const held = await db
      .update(collectTransfers)
      .set({ status: 'review', reviewReason: 'staff', updatedAt: i.now })
      .where(
        and(
          eq(collectTransfers.id, i.transferId),
          inArray(collectTransfers.status, ['waiting', 'ready']),
        ),
      )
      .returning({ id: collectTransfers.id });
    return held.length === 1;
  });
}

/**
 * Staff retry a share in review (P13, P20): only one held by staff or by the partner's answer. A
 * dispute's, a refund's or a shared bank account's review is released by its own flow. It goes to
 * `ready` with the account it had, or `waiting` with none (to be released with the account then).
 * A `provider` review is retried only once staff have checked the partner dashboard for the group:
 * the send uses the same key, and the read-back rules still apply.
 */
export function retryCollectTransfer(
  db: Database,
  i: { transferId: string; now: Date },
): Promise<'ready' | 'waiting' | 'refused'> {
  return guarded(async () => {
    const [moved] = await db
      .update(collectTransfers)
      .set({
        status: sql`CASE WHEN ${collectTransfers.accountReference} IS NULL THEN 'waiting' ELSE 'ready' END`,
        reviewReason: null,
        nextTryAt: i.now,
        updatedAt: i.now,
      })
      .where(
        and(
          eq(collectTransfers.id, i.transferId),
          eq(collectTransfers.status, 'review'),
          inArray(collectTransfers.reviewReason, ['provider', 'staff']),
        ),
      )
      .returning({ status: collectTransfers.status });
    if (!moved) return 'refused';
    return moved.status === 'ready' ? 'ready' : 'waiting';
  });
}

/** Whether a recipient has shares waiting (so an account event is worth a capability read). */
export function hasWaitingCollectTransfers(
  db: Database,
  profileId: string,
): Promise<boolean> {
  return guarded(async () => {
    const [row] = await db
      .select({ id: collectTransfers.id })
      .from(collectTransfers)
      .where(
        and(
          eq(collectTransfers.profileId, profileId),
          eq(collectTransfers.kind, 'share'),
          eq(collectTransfers.status, 'waiting'),
        ),
      )
      .limit(1);
    return Boolean(row);
  });
}
