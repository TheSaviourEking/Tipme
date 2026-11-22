import {
  bachsEnvironment,
  PLATFORM_REFUSAL_EVENT,
  recordedProviderName,
} from '@tipme/contracts';
import {
  buildCollectReturnPosting,
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
  tipRefunds,
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
import { enqueueOutbox } from './outbox.js';
import { reportProviderKeyRefused } from './payout-start.js';

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
 * lost is asked again with that key while the partner surely still knows it (KEY_TRUSTED_FOR_MS
 * from the first send of the key), and read back by `transfer_group` after that. Never a new key,
 * never a send on a forgotten key without a read-back. `sent_at` is when the key was first sent in
 * its current window; only a send after a read-back that found nothing starts a new one.
 */

/** A claimed row whose worker gave no word for this long is read back. */
export const READ_BACK_AFTER_MS = 2 * 60_000;
/** How long the partner replays a key (its idempotency window). */
export const SAME_KEY_WITHIN_MS = 24 * 3_600_000;
/**
 * How long TipMe trusts the partner to replay a key: an hour short of its window, so a clock
 * difference or a slow request never lands a same-key retry on a key it has forgotten (I1).
 */
export const KEY_TRUSTED_FOR_MS = SAME_KEY_WITHIN_MS - 3_600_000;
/** A share bouncing on a lost capability for longer than this raises an issue for its recipient. */
const CAPABILITY_STUCK_AFTER_MS = 24 * 3_600_000;
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
  /**
   * Task 9: a `back` row, money from the recipient's account back to TipMe's (`collectToPlatform`,
   * `transfer_group` = the key). PayoutRejectedError and PlatformRefusalError are definite refusals;
   * anything else may have moved. Without it, `back` rows wait.
   */
  collectBack?(input: {
    accountRef: string;
    amountMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
  }): Promise<{ transferRef: string; status: 'paid' | 'pending' }>;
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
 * which every claim raises), and for a claim only once due and while `claim.where` holds. So of any number of workers exactly one
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
  claim?: { where: SQL },
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
        ...(claim ? [lte(collectTransfers.nextTryAt, now), claim.where] : []),
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
         SET status = 'ready',
             -- A share sent before keeps the account its key went to: a read-back must look there.
             account_reference = CASE WHEN c.sent_at IS NULL THEN a.reference ELSE c.account_reference END,
             next_try_at = ${now}::timestamptz,
             updated_at = ${now}::timestamptz
        FROM (
          SELECT w.id, ${currentAccount('w')} AS reference
            FROM collect_transfers w
           WHERE w.status = 'waiting' AND w.kind = 'share'
             AND (w.release_after IS NULL OR w.release_after <= ${now}::timestamptz)
             AND ${i.profileId ? sql`w.profile_id = ${i.profileId}` : sql`w.next_try_at <= ${now}::timestamptz`}
             AND ${canReceive('w')}
        ) a
       WHERE c.id = a.id AND c.status = 'waiting' AND a.reference IS NOT NULL
         AND (c.sent_at IS NULL OR c.account_reference IS NOT NULL)
      RETURNING c.id`);
    return result.rows.length;
  });
}

/**
 * The recipient's account now, for a collect transfer row aliased `alias`: their payment account
 * for its provider and environment (the pretend provider's is the profile id).
 */
function currentAccount(alias: string): SQL {
  const c = sql.raw(alias);
  return sql`COALESCE(
    (SELECT pa.provider_account_reference FROM payment_accounts pa
      WHERE pa.profile_id = ${c}.profile_id AND pa.provider = ${c}.provider
        AND pa.environment = ${c}.environment),
    CASE WHEN ${c}.provider = ${PRETEND_PROVIDER} THEN ${c}.profile_id::text END)`;
}

/**
 * Whether the row's recipient can receive it now (spec §5, §8): verified, a `usable` bank that
 * hasn't been replaced, no shared bank account in review or open as an issue (Task 13), no open
 * dispute on the tip (nor a lost one TipMe is still recovering, nor a closed one whose hold is kept
 * for a refund). Checked when a share is released and again, with its account, when it is claimed
 * to be sent.
 */
function canReceive(alias: string): SQL {
  const c = sql.raw(alias);
  return sql`EXISTS (
      SELECT 1 FROM profiles p
       WHERE p.id = ${c}.profile_id AND p.collect_verified_at IS NOT NULL)
    AND EXISTS (
      SELECT 1 FROM payout_destinations d
       WHERE d.profile_id = ${c}.profile_id AND d.provider = ${c}.provider
         AND d.replaced_at IS NULL AND d.status = 'usable')
    AND NOT EXISTS (
      SELECT 1 FROM collect_transfers r
       WHERE r.profile_id = ${c}.profile_id AND r.status = 'review'
         AND r.review_reason = 'same_bank')
    AND NOT EXISTS (
      SELECT 1 FROM issues s
       WHERE s.kind = 'collect_same_bank' AND s.status = 'open'
         AND s.subject->>'profileId' = ${c}.profile_id::text)
    AND NOT EXISTS (
      SELECT 1 FROM disputes x
       WHERE x.tip_id = ${c}.tip_id
         AND (x.status IN ('open', 'responded')
              OR (x.status IN ('lost', 'closed') AND x.settled_at IS NULL)))`;
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
): Promise<string | null> {
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
  if (open) return null;
  const spell = newId();
  await openIssue(tx, {
    dedupeKey: `${input.prefix}${spell}`,
    kind: input.kind,
    subject: input.subject,
    note: input.note,
    now: input.now,
  });
  return spell;
}

const DEBT_PREFIX = 'collect_in_debt.';
const capabilityPrefix = (profileId: string) =>
  `collect_transfer_stuck.capability.${profileId}.`;
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
    const owner = { amountMinor: row.amountMinor, profileId: row.profileId };
    if (row.kind === 'back' && row.refundId)
      // Task 10: the refund's money is back in TipMe's balance (held for them, never withdrawable),
      // so its reservation of their account ends with this posting.
      await tx
        .update(tipRefunds)
        .set({ heldMinor: 0n, updatedAt: now })
        .where(eq(tipRefunds.id, row.refundId));
    if (row.kind === 'return')
      // Task 10 (RI1): what a failed refund took back is theirs again, in their account; the hold
      // that kept it from their balance ends with the posting, once.
      await tx
        .update(tipRefunds)
        .set({ heldMinor: 0n, updatedAt: now })
        .where(
          and(eq(tipRefunds.tipId, row.tipId), eq(tipRefunds.status, 'FAILED')),
        );
    await postLedgerTransaction(tx, {
      operationType: 'collect_transfer',
      operationKey: `collect_transfer.${row.id}`,
      currency: row.currency,
      tipId: row.tipId,
      traceId: null,
      // A share moves held money to the recipient's account; a transfer back returns it (Task 9).
      lines:
        row.kind === 'back'
          ? buildCollectReturnPosting(owner)
          : buildCollectTransferPosting(owner),
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
  /**
   * The partner definitely refused this send (Task 9): nothing moved under the key, so the row is
   * proven unmoved and a dispute or refund may take it (`refused_at`, P27).
   */
  definitelyRefused = false,
): Promise<Outcome> {
  return db.transaction(async (tx) => {
    const held = await move(tx, row, from, 'review', now, {
      reviewReason: 'provider',
      ...(definitelyRefused ? { refusedAt: now } : {}),
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

/** Whether a key sent at `sentAt` is still one the partner replays (with a margin, I1). */
function keyTrusted(sentAt: Date | null, now: Date): boolean {
  return (
    sentAt !== null && now.getTime() - sentAt.getTime() < KEY_TRUSTED_FOR_MS
  );
}

/** The row still goes to its recipient's current account, and they can receive it (I4). */
const stillReceivable = sql`${collectTransfers.accountReference} = ${currentAccount('collect_transfers')}
  AND ${canReceive('collect_transfers')}`;

/**
 * What a claim of this row must still hold. A share: its recipient can receive it on that account.
 * A transfer back (Task 9) comes from the account the share went to, where the money is, whatever
 * the recipient has done since: nothing about them gates it.
 */
const claimWhere = (row: Row): SQL =>
  row.kind === 'share' ? stillReceivable : sql`TRUE`;

/** Whether the row can be sent now (see claimWhere). */
async function receivableNow(db: Database, row: Row): Promise<boolean> {
  // A transfer back, and a return of what one took (Task 10), go to the account the money came
  // from: nothing about the recipient now gates them.
  if (row.kind !== 'share') return true;
  const [receivable] = await db
    .select({ id: collectTransfers.id })
    .from(collectTransfers)
    .where(and(eq(collectTransfers.id, row.id), stillReceivable));
  return Boolean(receivable);
}

/**
 * Sends a `ready` row: the claim first, committed, then the one partner call.
 *
 * The claim re-checks what release checked: a recipient whose bank was replaced, who lost their
 * verification, whose bank is shared or whose tip is disputed, or whose account is no longer the
 * row's, is not sent to; the share goes back to `waiting` without an account, to be released again.
 *
 * `sent_at` is the start of the key's window at the partner. The claim never restarts it while the
 * key is forgotten (C1): only the send that follows a read-back finding nothing in the group starts
 * a new window (`readJustNow`). A share sent before whose key is no longer trusted is claimed and
 * read back first, so a lost read, or a worker dying between the claim and the read, leaves the key
 * still forgotten and the next run reads back again. Never a send on a key the partner may have
 * forgotten without proof that nothing moved under it.
 */
async function send(
  db: Database,
  row: Row,
  provider: CollectTransferProvider,
  now: Date,
  totals: CollectTransferRun,
  readJustNow = false,
): Promise<Outcome> {
  // A transfer back needs its own call; without it the row waits, unclaimed.
  if (row.kind === 'back' && !provider.collectBack) return 'none';
  const accountRef = row.accountReference;
  if (!accountRef || row.currency !== 'NGN')
    return toReview(
      db,
      row,
      'ready',
      now,
      'This share names no account, or a currency the partner cannot send.',
    );
  const neverSent = row.sentAt === null;
  const forgotten = !neverSent && !keyTrusted(row.sentAt, now);
  if (forgotten && !readJustNow) {
    // Read back first, on the account the key was sent to, whatever else has changed since:
    // nothing is sent by this claim, so the recipient's current state doesn't gate it.
    const claimed = await move(
      db,
      row,
      'ready',
      'sent',
      now,
      { attempts: sql`${collectTransfers.attempts} + 1` },
      { where: sql`TRUE` },
    );
    if (!claimed) return 'none';
    return readBack(db, claimed, 'sent', provider, now, totals);
  }
  // Nothing has moved under this key: never sent, or a read-back on its own account just found
  // nothing in its group after the partner forgot the key.
  const provenUnmoved = neverSent || (forgotten && readJustNow);
  if (!(await receivableNow(db, row))) {
    if (provenUnmoved) {
      // Starts over: released again later, to the account the recipient has then.
      const back = await move(db, row, 'ready', 'waiting', now, {
        accountReference: null,
        sentAt: null,
        nextTryAt: now,
      });
      return back ? 'retried' : 'none';
    }
    return keepForReadBack(db, row, 'ready', now);
  }
  const freshWindow = provenUnmoved;
  const claimed = await move(
    db,
    row,
    'ready',
    'sent',
    now,
    {
      attempts: sql`${collectTransfers.attempts} + 1`,
      ...(freshWindow ? { sentAt: now } : {}),
    },
    { where: claimWhere(row) },
  );
  if (!claimed) return 'none';
  if (forgotten && !readJustNow)
    return readBack(db, claimed, 'sent', provider, now, totals);
  totals.sent += 1;
  let answer: { transferRef: string; status: 'paid' | 'pending' };
  try {
    const input = {
      accountRef,
      amountMinor: claimed.amountMinor,
      currency: 'NGN' as const,
      idempotencyKey: claimed.idempotencyKey,
    };
    answer =
      claimed.kind === 'back'
        ? await provider.collectBack!(input)
        : await provider.sendCollectTransfer(input);
  } catch (error) {
    return claimed.kind === 'back'
      ? refusedBack(db, claimed, now, error, freshWindow)
      : refused(db, claimed, provider, accountRef, now, error, freshWindow);
  }
  if (answer.status === 'paid')
    return finishPaid(db, claimed, 'sent', answer.transferRef, now);
  // Pending at the partner: read back once its worker's turn is over.
  await move(db, claimed, 'sent', 'sent', now, {
    transferReference: answer.transferRef,
  });
  return 'none';
}

/**
 * M1: a share that could have moved for over a day (since it was due and its recipient verified)
 * and still bounces on their lost capability needs a person: one issue per recipient at a time.
 */
async function capabilityStuck(tx: Tx, row: Row, now: Date): Promise<void> {
  const [profile] = await tx
    .select({ verifiedAt: profiles.collectVerifiedAt })
    .from(profiles)
    .where(eq(profiles.id, row.profileId));
  const since = Math.max(
    (row.releaseAfter ?? row.createdAt).getTime(),
    profile?.verifiedAt?.getTime() ?? now.getTime(),
  );
  if (now.getTime() - since <= CAPABILITY_STUCK_AFTER_MS) return;
  await openOnce(tx, {
    prefix: capabilityPrefix(row.profileId),
    kind: 'collect_transfer_stuck',
    subject: { tipId: row.tipId, profileId: row.profileId },
    note: `The partner keeps refusing transfer ${row.id} because the recipient's account can't receive transfers, and has for over a day. Check the account's capabilities at the partner.`,
    now,
  });
}

/** What a failed send means. Only a definite refusal proves no money moved. */
async function refused(
  db: Database,
  row: Row,
  provider: CollectTransferProvider,
  accountRef: string,
  now: Date,
  error: unknown,
  /**
   * The refused send opened the key's window (never sent before, or a read-back on its account just
   * found nothing): only then does a definite refusal prove nothing ever moved under the key. A
   * refusal on a same-key retry after an uncertain answer proves only that this request didn't.
   */
  freshWindow: boolean,
): Promise<Outcome> {
  const reason = refusalOf(error);
  // Task 10: a return goes to one account, the one the money came from; any refusal of it but
  // TipMe's own balance or debt needs a person (it never waits on the recipient's capability).
  if (
    row.kind === 'return' &&
    reason !== null &&
    reason !== 'insufficient' &&
    reason !== 'in_debt'
  )
    return toReview(
      db,
      row,
      'sent',
      now,
      'The partner refused returning money a refund took back to the recipient. Nothing moved.',
      freshWindow,
    );
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
    // R11: TipMe's own account is in debt. Every collect transfer stops behind one issue, and
    // staff are paged once per spell, in the issue's transaction (as openPlatformRefusalIssue).
    await db.transaction(async (tx) => {
      await move(tx, row, 'sent', 'ready', now, { nextTryAt: now });
      const spell = await openOnce(tx, {
        prefix: DEBT_PREFIX,
        kind: 'collect_in_debt',
        subject: {},
        note: `The partner answered ORGANIZATION_IN_DEBT to transfer ${row.id}. Nothing moved.`,
        now,
      });
      // The cause only: the alert route is a chat room.
      if (spell)
        await enqueueOutbox(tx, {
          eventType: PLATFORM_REFUSAL_EVENT,
          aggregateId: spell,
          payload: { cause: 'collect_in_debt' },
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
      // The recipient's account can receive: the refusal was TipMe's key. Reported as every refusal
      // of TipMe's key is (one issue per spell, with its alert); nobody goes back to waiting.
      await move(db, row, 'sent', 'ready', now, {
        nextTryAt: backoff(row.attempts, now),
      });
      await reportProviderKeyRefused(db, { now });
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
      await capabilityStuck(tx, row, now);
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
    freshWindow,
  );
}

/**
 * A failed transfer back (Task 9, and Task 10's refunds). It runs as the recipient's account, so its refusals are theirs:
 * ORGANIZATION_IN_DEBT there is the RECIPIENT in debt (P14), never TipMe's, so it freezes nothing
 * else. Every definite refusal goes to review with a money issue (the dispute waits for staff);
 * TipMe's own key refused stops the run as for a share; anything else may have moved.
 */
async function refusedBack(
  db: Database,
  row: Row,
  now: Date,
  error: unknown,
  /**
   * As for a share (P30): only a refusal of the send that opened the key's window proves nothing
   * ever moved under it, so only then is the row marked refused (a refund then fails cleanly).
   */
  freshWindow: boolean,
): Promise<Outcome> {
  const name = error instanceof Error ? error.name : null;
  // PayoutRejectedError says why as `failureReason`; PlatformRefusalError as `refusal`.
  const fields = (error ?? {}) as {
    failureReason?: unknown;
    refusal?: unknown;
  };
  const reason = fields.failureReason;
  if (name === 'PlatformRefusalError' && fields.refusal === 'provider_key') {
    await move(db, row, 'sent', 'ready', now, {
      nextTryAt: backoff(row.attempts, now),
    });
    await reportProviderKeyRefused(db, { now });
    return { stop: 'platform' };
  }
  if (name === 'PayoutRejectedError' || name === 'PlatformRefusalError')
    return toReview(
      db,
      row,
      'sent',
      now,
      reason === 'in_debt'
        ? `The partner answered ORGANIZATION_IN_DEBT to this transfer back: the recipient's account is in debt (not TipMe's). Nothing moved; the ${row.refundId ? 'refund' : 'lost dispute'} waits for it.`
        : `The partner refused this transfer back. Nothing moved; the ${row.refundId ? 'refund' : 'lost dispute'} waits for it.`,
      freshWindow,
    );
  await move(db, row, 'sent', 'unknown', now, {
    nextTryAt: unknownWait(row.attempts, now),
  });
  return 'retried';
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
  // The group is optional on the partner's list items: a transfer to this account with no group and
  // this share's money may be this one. Never "not found", so never a second send; a person checks.
  if (
    listed.some(
      (t) =>
        t.group === null &&
        t.amountMinor === row.amountMinor &&
        t.currency === row.currency,
    )
  )
    return toReview(
      db,
      row,
      from,
      now,
      'The partner lists a transfer with this amount and no group, so TipMe cannot tell whether this share moved.',
    );
  // Nothing moved under this key: the same key again (the claim starts a new window if it's over).
  const again = await move(db, row, from, 'ready', now, { nextTryAt: now });
  if (!again) return 'none';
  return send(db, again, provider, now, totals, true);
}

/**
 * A share that may have moved under a key the partner still replays, but can't be sent now (its
 * recipient's account changed, or they can't receive). It keeps its account and is not sent, held
 * back, or returned to waiting: once the key is no longer trusted it is read back on that account,
 * the only place the money could have gone. Found, it is paid; not found, it starts over.
 */
async function keepForReadBack(
  db: Database,
  row: Row,
  from: 'ready' | 'unknown',
  now: Date,
): Promise<Outcome> {
  const readBackAt = new Date(
    (row.sentAt ?? now).getTime() + KEY_TRUSTED_FOR_MS,
  );
  const kept = await move(db, row, from, from, now, {
    nextTryAt: readBackAt > now ? readBackAt : now,
  });
  return kept ? 'retried' : 'none';
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
  if (!keyTrusted(row.sentAt, now))
    return readBack(db, row, 'unknown', provider, now, totals);
  // Inside the partner's window: the same key replays a transfer that moved, or makes the one. But
  // only to a recipient who can still receive it on the same account; otherwise it waits, with its
  // account, for a read-back there.
  if (!(await receivableNow(db, row)))
    return keepForReadBack(db, row, 'unknown', now);
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
    // Shares, and transfers back for lost disputes (Task 9): the same machine.
    // Task 10: and returns of what a failed refund took back.
    inArray(collectTransfers.kind, ['share', 'back', 'return']),
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
           AND c.kind IN ('share', 'back', 'return') AND c.status = 'ready'
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
  for (const [index, { row, step }] of work.entries()) {
    // M2: staff's pause, or a debt another worker ran into, stops the rest of this run too.
    if (index > 0) {
      if ((await guarded(() => collectSettingsInForce(db, now))).paused)
        return { ...totals, stopped: 'paused' };
      if (await guarded(() => frozenByDebt(db)))
        return { ...totals, stopped: 'in_debt' };
    }
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
 * Staff hold a share for a manual check (P13 `staff`). Only one never sent, or one a read-back on
 * its own account has proved unmoved (that clears `sent_at`): a share that may have been sent is
 * never held by hand, whatever its status, since its money may have moved.
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
          // Never one that may have been sent: only a read-back on its account settles that.
          isNull(collectTransfers.sentAt),
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
        refusedAt: null,
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

/*
 * P27: the one guard every dispute and refund hook uses before it holds, releases-for-cancel or
 * cancels a share. A share whose money may have moved (it was sent under its key: `sent_at` set,
 * whatever its status now) is never taken by a hook: only a read-back on the account it went to
 * settles it, and the hook waits for that (Review Focus 3). The database's
 * `collect_transfers_never_cancel_sent` check backs this up for `cancelled`.
 */

/** Where a tip's share is, for a refund or dispute (spec §6, ShareWhere in @tipme/domain). */
export type SharePosition =
  | { state: 'held'; row: Row }
  | { state: 'moved'; row: Row }
  | { state: 'in_flight'; row: Row }
  | { state: 'gone'; row: Row | null };

/**
 * Proven unmoved (P27): never sent, or held in review after the partner definitely refused its last
 * send (`refused_at`). Anything else that was sent may have moved.
 */
const unmovedShare = sql`${collectTransfers.kind} = 'share' AND (
  (${collectTransfers.sentAt} IS NULL AND ${collectTransfers.status} IN ('waiting', 'ready', 'review'))
  OR (${collectTransfers.status} = 'review' AND ${collectTransfers.refusedAt} IS NOT NULL))`;

/** The tip's share row and where its money is. */
export async function sharePosition(
  tx: Database | Tx,
  tipId: string,
): Promise<SharePosition> {
  const [row] = await tx
    .select()
    .from(collectTransfers)
    .where(
      and(
        eq(collectTransfers.tipId, tipId),
        eq(collectTransfers.kind, 'share'),
      ),
    );
  if (!row) return { state: 'gone', row: null };
  if (row.status === 'paid') return { state: 'moved', row };
  if (row.status === 'cancelled') return { state: 'gone', row };
  if (
    (row.sentAt === null &&
      (row.status === 'waiting' ||
        row.status === 'ready' ||
        row.status === 'review')) ||
    (row.status === 'review' && row.refusedAt !== null)
  )
    return { state: 'held', row };
  return { state: 'in_flight', row };
}

/**
 * Takes a share that is proven unmoved: to `review` (held, with its reason) or to `cancelled`.
 * Conditional on `unmovedShare`, in the caller's transaction; false when the share may have moved,
 * so nothing changed. A row already in review for another reason keeps that reason when held.
 */
export async function takeUnsentShare(
  tx: Database | Tx,
  i: {
    transferId: string;
    to: 'review' | 'cancelled';
    reviewReason: 'dispute' | 'refund';
    now: Date;
  },
): Promise<boolean> {
  return guarded(async () => {
    const moved = await tx
      .update(collectTransfers)
      .set({
        status: i.to,
        ...(i.to === 'review'
          ? {
              reviewReason: sql`CASE WHEN ${collectTransfers.status} = 'review' THEN ${collectTransfers.reviewReason} ELSE ${i.reviewReason} END`,
            }
          : {}),
        updatedAt: i.now,
      })
      .where(and(eq(collectTransfers.id, i.transferId), unmovedShare))
      .returning({ id: collectTransfers.id });
    return moved.length === 1;
  });
}

/**
 * Lets go of a share a dispute (or refund) held (P13, P20): only a never-sent share in review for
 * that reason, to `ready` with its account or `waiting` without one. A row held for another reason
 * stays held. `as` hands it on to another reason instead (a closed dispute to the refund) without
 * releasing it.
 */
export async function releaseHeldShare(
  tx: Database | Tx,
  i: {
    transferId: string;
    reason: 'dispute' | 'refund';
    now: Date;
    as?: 'refund';
  },
): Promise<boolean> {
  return guarded(async () => {
    const moved = await tx
      .update(collectTransfers)
      .set(
        i.as
          ? { reviewReason: i.as, updatedAt: i.now }
          : {
              status: sql`CASE WHEN ${collectTransfers.accountReference} IS NULL THEN 'waiting' ELSE 'ready' END`,
              reviewReason: null,
              nextTryAt: i.now,
              updatedAt: i.now,
            },
      )
      .where(
        and(
          eq(collectTransfers.id, i.transferId),
          eq(collectTransfers.kind, 'share'),
          isNull(collectTransfers.sentAt),
          eq(collectTransfers.status, 'review'),
          eq(collectTransfers.reviewReason, i.reason),
        ),
      )
      .returning({ id: collectTransfers.id });
    return moved.length === 1;
  });
}

/**
 * A lost dispute that took less than a share proven unmoved (P27 guard, as takeUnsentShare): the
 * share keeps the rest. Held for the dispute, it is released (to `ready` with its account or
 * `waiting` without one); held for another reason, or not held, it stays as it is.
 */
export async function reduceUnsentShare(
  tx: Database | Tx,
  i: { transferId: string; byMinor: bigint; now: Date },
): Promise<boolean> {
  return guarded(async () => {
    const forDispute = sql`${collectTransfers.status} = 'review' AND ${collectTransfers.reviewReason} = 'dispute'`;
    const moved = await tx
      .update(collectTransfers)
      .set({
        amountMinor: sql`${collectTransfers.amountMinor} - ${i.byMinor}`,
        status: sql`CASE WHEN ${forDispute}
          THEN (CASE WHEN ${collectTransfers.accountReference} IS NULL THEN 'waiting' ELSE 'ready' END)
          ELSE ${collectTransfers.status} END`,
        reviewReason: sql`CASE WHEN ${forDispute} THEN NULL ELSE ${collectTransfers.reviewReason} END`,
        nextTryAt: i.now,
        updatedAt: i.now,
      })
      .where(
        and(
          eq(collectTransfers.id, i.transferId),
          unmovedShare,
          // A refused row released for a dispute would carry its refusal out of review.
          sql`NOT (${forDispute} AND ${collectTransfers.refusedAt} IS NOT NULL)`,
          sql`${collectTransfers.amountMinor} > ${i.byMinor}`,
        ),
      )
      .returning({ id: collectTransfers.id });
    return moved.length === 1;
  });
}
