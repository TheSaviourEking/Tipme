import { bachsEnvironment, recordedProviderName } from '@tipme/contracts';
import { allocateHoldbacks, refundMoves, type LedgerLine } from '@tipme/domain';
import { and, asc, eq, gt, inArray, lte, or, sql } from 'drizzle-orm';
import type { Database, Tx } from '../client.js';
import {
  businesses,
  notifications,
  paymentAccounts,
  shareHoldbacks,
  shareTransfers,
  tipBusinessShares,
} from '../schema.js';
import { businessManagerUsers } from './business-ops.js';
import { guarded } from './errors.js';
import { newId } from './ids.js';
import { openIssue } from './issues.js';

/*
 * Business release 2 on option B (owner, 11 Nov 2026). A shared tip is a direct charge on the staff
 * member's own partner account, as every tip is; the ledger already splits it (the business's share
 * is its own `business_payable` line). The partner refuses a transfer between two accounts ("a
 * transfer must have the platform on exactly one side", sandbox S4), so the money for the share is
 * moved in two legs through TipMe's own balance:
 *
 *   out: the source account -> TipMe (`destination: "self"`, as the source), key tipme-share-out-<id>
 *   in:  TipMe -> the destination account (as the platform),            key tipme-share-in-<id>
 *
 * Each leg is claimed in the database before the partner is asked (`out_sent` / `in_sent`), so a
 * crash or a lost answer is read back from the partner by its key (its `transfer_group`), never sent
 * blindly. The second leg starts only once the first is confirmed `paid`. A row is worked by one
 * worker at a time: every move from a sendable state is a conditional update that only one wins.
 *
 * Nothing here posts to the ledger: it already says who is owed what, and these transfers only make
 * each partner balance match it.
 */

export type ShareTransferKind =
  'sweep' | 'recover' | 'fee_return' | 'holdback_repay';
export type ShareTransferStatus =
  | 'waiting'
  | 'out_sent'
  | 'out_paid'
  | 'in_sent'
  | 'done'
  | 'cancelled'
  | 'gap'
  | 'review';

type Transfer = { transferRef: string; status: 'paid' | 'pending' };

/** The partner calls option B uses: the payout port's, nothing new beyond TipMe -> account. */
export interface ShareTransferProvider {
  name: string;
  capabilities?: { connectedAccounts?: boolean };
  payoutBalance(
    accountRef: string,
    currency: 'NGN',
  ): Promise<{ availableMinor: bigint }>;
  collectToPlatform?(input: {
    accountRef: string;
    amountMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
    description?: string;
  }): Promise<Transfer>;
  transferToAccount?(input: {
    accountRef: string;
    amountMinor: bigint;
    currency: 'NGN';
    idempotencyKey: string;
    description: string;
  }): Promise<Transfer>;
  findPlatformCollection?(
    accountRef: string,
    idempotencyKey: string,
  ): Promise<{
    transferRef: string;
    status: 'paid' | 'pending';
    amountMinor: bigint;
    currency: string;
  } | null>;
}

export const shareOutKey = (id: string) => `tipme-share-out-${id}`;
export const shareInKey = (id: string) => `tipme-share-in-${id}`;
/** What the partner's records say a transfer is for. Never a person's or a business's name. */
const DESCRIPTION = 'TipMe business share';

/** A lost answer is read back after this long; not found this long after sending, nothing moved. */
const READ_BACK_AFTER_MS = 2 * 60_000;
const GIVE_UP_AFTER_MS = 30 * 60_000;
/** A definite refusal of TipMe's own leg this many times needs a person. */
const IN_ATTEMPTS_BEFORE_REVIEW = 5;

/** Waits after a step that couldn't go ahead: 5 minutes, doubling, at most 6 hours. */
function backoff(attempts: number, now: Date): Date {
  const minutes = Math.min(5 * 2 ** Math.max(0, attempts - 1), 360);
  return new Date(now.getTime() + minutes * 60_000);
}

/** A refusal that proves no money moved (as for a Pro payment from the balance). */
function definitelyNotMoved(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return [
    'PayoutRejectedError',
    'PlatformRefusalError',
    'BachsRequestNotSentError',
  ].includes(error.name);
}

/** Which way each kind moves money: the account the `out` leg takes from, and where `in` sends. */
const SOURCE: Record<ShareTransferKind, 'staff' | 'business' | null> = {
  sweep: 'staff',
  recover: 'business',
  fee_return: null,
  holdback_repay: null,
};
const DESTINATION: Record<ShareTransferKind, 'staff' | 'business'> = {
  sweep: 'business',
  recover: 'staff',
  fee_return: 'staff',
  holdback_repay: 'staff',
};

type Row = typeof shareTransfers.$inferSelect;

/** Every kind but a fee return is about a business (the database checks it). */
function businessOf(row: Row): string {
  if (!row.businessId) throw new Error('this share transfer names no business');
  return row.businessId;
}

/**
 * Called with the payment's posting, in its transaction: a paid shared tip gets one sweep, waiting
 * for the tip's money to become available on the staff member's account. Once per tip.
 */
export async function scheduleShareSweep(
  tx: Tx,
  input: {
    tipId: string;
    profileId: string;
    businessId: string;
    amountMinor: bigint;
    currency: string;
    provider: string;
  },
): Promise<void> {
  await tx
    .insert(shareTransfers)
    .values({
      id: newId(),
      tipId: input.tipId,
      kind: 'sweep',
      businessId: input.businessId,
      profileId: input.profileId,
      currency: input.currency,
      amountMinor: input.amountMinor,
      status: 'waiting',
      provider: input.provider,
    })
    .onConflictDoNothing();
}

/**
 * Called by `reverseTip` with the reversal it just posted, in its transaction, for a shared tip.
 * Our partner takes the whole refund from the staff member's account and keeps TipMe's fee with
 * TipMe (sandbox S5), so to leave them even (owner, 11 Nov 2026):
 *
 * - TipMe's fee: `scheduleFeeReturn`, once per partner refund (see there).
 * - The business's part: a sweep still waiting simply moves less (or nothing): the money never left
 *   the staff member's account. Once the sweep has started, the business gives it back
 *   (`recover`, business -> TipMe -> staff), after the sweep has finished.
 *
 * Once per reversal and kind (the database's unique index).
 */
export async function planRefundTransfers(
  tx: Tx,
  input: {
    tipId: string;
    reversalTransactionId: string;
    lines: readonly LedgerLine[];
    now: Date;
  },
): Promise<void> {
  const [share] = await tx
    .select({ businessId: tipBusinessShares.businessId })
    .from(tipBusinessShares)
    .where(eq(tipBusinessShares.tipId, input.tipId));
  if (!share) return;
  const [sweep] = await tx
    .select()
    .from(shareTransfers)
    .where(
      and(
        eq(shareTransfers.tipId, input.tipId),
        eq(shareTransfers.kind, 'sweep'),
      ),
    )
    .for('update');
  if (!sweep) return;
  // TipMe's fee goes back through `scheduleFeeReturn` (reverseTip calls it for every tip it
  // applies to, keyed on the partner's refund), never here: one fee return per refund.
  const { businessBackMinor } = refundMoves(input.lines, {
    businessId: share.businessId,
  });
  const base = {
    tipId: input.tipId,
    businessId: sweep.businessId,
    profileId: sweep.profileId,
    currency: sweep.currency,
    provider: sweep.provider,
    reversalTransactionId: input.reversalTransactionId,
  };
  if (businessBackMinor <= 0n) return;
  if (sweep.status === 'waiting') {
    // Under the sweep's lock: the worker claims it with a conditional update, so it is still unsent.
    const left = sweep.amountMinor - businessBackMinor;
    await tx
      .update(shareTransfers)
      .set(
        left > 0n
          ? { amountMinor: left, updatedAt: input.now }
          : { status: 'cancelled', updatedAt: input.now },
      )
      .where(eq(shareTransfers.id, sweep.id));
    return;
  }
  if (sweep.status === 'cancelled') return;
  await tx
    .insert(shareTransfers)
    .values({
      ...base,
      id: newId(),
      kind: 'recover',
      amountMinor: businessBackMinor,
      status: 'waiting',
    })
    .onConflictDoNothing();
}

/**
 * TipMe returns its own fee on a refunded tip (owner, 12 Nov 2026; for a shared tip already on
 * 11 Nov): our partner takes the whole refund from the person's account and keeps TipMe's share with
 * TipMe, so TipMe sends its own fee back, TipMe -> the person's account. The processing TipMe
 * recovered from the tip is not returned (owner, 14 Nov 2026): the person bears it, and
 * `reverseTip` books that on their payable (`refund_processing`). Called when a refund is final (`refund.paid`) and when staff reverse a lost
 * dispute. Exactly once per partner refund or dispute (the `share_transfers_fee_once` index), and
 * never more than the tip's fee in all. `amountMinor` is the reversal's own figure when there is
 * one; otherwise the fee in proportion to what was refunded, rounded down.
 *
 * The reversal already takes TipMe's fee back from its revenue (`buildReversalPosting`), and both
 * balances this moves between are the partner balance (`provider_clearing`). With `reverseTip`'s
 * `refund_processing` posting, the person's partner balance matches what the ledger says.
 */
export async function scheduleFeeReturn(
  tx: Tx,
  input: {
    tipId: string;
    partnerReversalId: string;
    refundedMinor: bigint;
    amountMinor?: bigint;
  },
): Promise<boolean> {
  const result = await tx.execute<{
    profile_id: string | null;
    currency: string;
    gross: string;
    fee: string;
    provider: string | null;
    business_id: string | null;
    returned: string;
  }>(sql`
    SELECT t.profile_id, t.currency, q.tip_minor::text AS gross,
           -- TipMe's own fee on the quote: never the processing part (provider_fee_minor) TipMe
           -- recovered from the tip, which it keeps (owner, 14 Nov 2026).
           q.platform_fee_minor::text AS fee,
           (SELECT a.provider FROM payment_attempts a
             WHERE a.intent_id = t.intent_id AND a.status = 'VERIFIED_SUCCEEDED' LIMIT 1) AS provider,
           (SELECT s.business_id FROM tip_business_shares s WHERE s.tip_id = t.id) AS business_id,
           (SELECT COALESCE(SUM(r.amount_minor), 0) FROM share_transfers r
             WHERE r.tip_id = t.id AND r.kind = 'fee_return')::text AS returned
      FROM tips t
      JOIN payment_intents i ON i.id = t.intent_id
      JOIN tip_quotes q ON q.id = i.quote_id
     WHERE t.id = ${input.tipId}
     FOR UPDATE OF t`);
  const tip = result.rows[0];
  // A team tip (no one person) and a tip never confirmed paid have nothing to send back here.
  if (!tip?.profile_id || !tip.provider) return false;
  const fee = BigInt(tip.fee);
  const gross = BigInt(tip.gross);
  const proportional = gross > 0n ? (fee * input.refundedMinor) / gross : 0n;
  const wanted = input.amountMinor ?? proportional;
  const left = fee - BigInt(tip.returned);
  const amountMinor = wanted < left ? wanted : left;
  if (amountMinor <= 0n) return false;
  const inserted = await tx
    .insert(shareTransfers)
    .values({
      id: newId(),
      tipId: input.tipId,
      kind: 'fee_return',
      businessId: tip.business_id,
      profileId: tip.profile_id,
      currency: tip.currency,
      amountMinor,
      deliverMinor: amountMinor,
      status: 'out_paid',
      provider: tip.provider,
      partnerReversalId: input.partnerReversalId,
    })
    .onConflictDoNothing()
    .returning({ id: shareTransfers.id });
  return inserted.length === 1;
}

/** The partner account of a staff member or a business, or (the pretend partner) their own id. */
async function accountOf(
  db: Database,
  owner: { profileId: string } | { businessId: string },
  provider: ShareTransferProvider,
): Promise<string | null> {
  if (provider.capabilities?.connectedAccounts === false)
    return 'businessId' in owner ? owner.businessId : owner.profileId;
  const environment = bachsEnvironment(provider.name);
  if (!environment) return null;
  const [account] = await db
    .select({ reference: paymentAccounts.providerAccountReference })
    .from(paymentAccounts)
    .where(
      and(
        'businessId' in owner
          ? eq(paymentAccounts.businessId, owner.businessId)
          : eq(paymentAccounts.profileId, owner.profileId),
        eq(paymentAccounts.provider, recordedProviderName(provider.name)),
        eq(paymentAccounts.environment, environment),
        // A business's account must be set up to receive; a person's has taken the tip already.
        ...('businessId' in owner
          ? [eq(paymentAccounts.status, 'ACTIVE')]
          : []),
      ),
    );
  return account?.reference ?? null;
}

const sideOf = (row: Row, side: 'staff' | 'business') =>
  side === 'staff'
    ? { profileId: row.profileId }
    : { businessId: businessOf(row) };

/** A conditional move: only from `from`, so of two workers exactly one gets it. */
async function claim(
  db: Database | Tx,
  row: Row,
  from: ShareTransferStatus,
  set: Partial<typeof shareTransfers.$inferInsert>,
): Promise<boolean> {
  const moved = await db
    .update(shareTransfers)
    .set({ ...set, updatedAt: sql`now()` })
    .where(and(eq(shareTransfers.id, row.id), eq(shareTransfers.status, from)))
    .returning({ id: shareTransfers.id });
  return moved.length === 1;
}

async function lockRow(tx: Tx, id: string): Promise<Row> {
  const [row] = await tx
    .select()
    .from(shareTransfers)
    .where(eq(shareTransfers.id, id))
    .for('update');
  if (!row) throw new Error('share transfer vanished');
  return row;
}

/** A person needs to look: TipMe may hold money it could not send on. Nothing is sent again. */
async function toReview(
  db: Database,
  row: Row,
  now: Date,
  note: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockRow(tx, row.id);
    if (current.status === 'done' || current.status === 'review') return;
    await tx
      .update(shareTransfers)
      .set({ status: 'review', updatedAt: now })
      .where(eq(shareTransfers.id, row.id));
    await openIssue(tx, {
      dedupeKey: `share_transfer_stuck.${row.id}`,
      kind: 'share_transfer_stuck',
      subject: { tipId: row.tipId, profileId: row.profileId },
      note: `${note} Share transfer ${row.id}, keys ${shareOutKey(row.id)} and ${shareInKey(row.id)}.`,
      now,
    });
  });
}

/**
 * The first leg is confirmed paid: TipMe now holds the money. For a sweep, what is held back for
 * earlier refunds the business had already withdrawn is set aside for those staff members now
 * (oldest first, under the hold-backs' lock), and only the rest goes on to the business.
 */
async function confirmOut(
  db: Database,
  row: Row,
  transferRef: string,
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockRow(tx, row.id);
    if (current.status !== 'out_sent') return;
    let deliver = current.amountMinor;
    if (current.kind === 'sweep') {
      const open = await tx
        .select({
          id: shareHoldbacks.id,
          profileId: shareHoldbacks.profileId,
          tipId: shareHoldbacks.tipId,
          remainingMinor: shareHoldbacks.remainingMinor,
        })
        .from(shareHoldbacks)
        .where(
          and(
            eq(shareHoldbacks.businessId, businessOf(current)),
            gt(shareHoldbacks.remainingMinor, 0n),
          ),
        )
        .orderBy(asc(shareHoldbacks.createdAt), asc(shareHoldbacks.id))
        .for('update');
      const { deliverMinor, repay } = allocateHoldbacks(
        current.amountMinor,
        open,
      );
      deliver = deliverMinor;
      for (const part of repay) {
        const holdback = open.find((h) => h.id === part.id)!;
        const remaining = holdback.remainingMinor - part.amountMinor;
        await tx
          .update(shareHoldbacks)
          .set({
            remainingMinor: remaining,
            ...(remaining === 0n ? { settledAt: now } : {}),
          })
          .where(eq(shareHoldbacks.id, part.id));
        await tx.insert(shareTransfers).values({
          id: newId(),
          tipId: holdback.tipId,
          kind: 'holdback_repay',
          businessId: businessOf(current),
          profileId: holdback.profileId,
          currency: current.currency,
          amountMinor: part.amountMinor,
          deliverMinor: part.amountMinor,
          status: 'out_paid',
          provider: current.provider,
          parentId: current.id,
          holdbackId: part.id,
        });
      }
    }
    await tx
      .update(shareTransfers)
      .set({
        status: deliver === 0n ? 'done' : 'out_paid',
        deliverMinor: deliver,
        outReference: transferRef,
        nextAttemptAt: now,
        updatedAt: now,
      })
      .where(eq(shareTransfers.id, row.id));
  });
}

/**
 * The business could not give a refunded tip's share back: it had already withdrawn it (sandbox
 * S5: "No debt is recorded, so once an account withdraws its balance, that money cannot be
 * recovered"). It is held back from the business's later shares and paid to the staff member, and
 * the business's owners are told in the app (no email: the amount is private).
 */
async function recordGap(db: Database, row: Row, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockRow(tx, row.id);
    if (current.status !== 'out_sent') return;
    await tx
      .update(shareTransfers)
      .set({ status: 'gap', updatedAt: now })
      .where(eq(shareTransfers.id, row.id));
    const holdbackId = newId();
    await tx.insert(shareHoldbacks).values({
      id: holdbackId,
      businessId: businessOf(current),
      profileId: current.profileId,
      tipId: current.tipId,
      recoverId: current.id,
      currency: current.currency,
      amountMinor: current.amountMinor,
      remainingMinor: current.amountMinor,
    });
    const [business] = await tx
      .select({ name: businesses.name })
      .from(businesses)
      .where(eq(businesses.id, businessOf(current)));
    const naira = `₦${new Intl.NumberFormat('en-NG', { minimumFractionDigits: 2 }).format(Number(current.amountMinor) / 100)}`;
    for (const userId of await businessManagerUsers(tx, businessOf(current), {
      owners: true,
    }))
      await tx.insert(notifications).values({
        id: newId(),
        userId,
        kind: 'business_share_held_back',
        businessId: businessOf(current),
        title: 'A refunded tip’s share is held back',
        body: `A tip shared with ${business?.name ?? 'your business'} was refunded after its share had been withdrawn. ${naira} will be held back from the business’s next shares and returned to the staff member.`,
        createdAt: now,
      });
  });
}

/** Moves the money for one row as far as it can go now. */
async function step(
  db: Database,
  row: Row,
  provider: ShareTransferProvider,
  now: Date,
): Promise<void> {
  const kind = row.kind as ShareTransferKind;
  if (row.status === 'waiting') return sendOut(db, row, kind, provider, now);
  if (row.status === 'out_paid') return sendIn(db, row, kind, provider, now);
  if (row.status === 'out_sent' || row.status === 'in_sent')
    return readBack(db, row, kind, provider, now);
}

async function postpone(db: Database, row: Row, now: Date): Promise<void> {
  await db
    .update(shareTransfers)
    .set({
      attempts: row.attempts + 1,
      nextAttemptAt: backoff(row.attempts + 1, now),
      updatedAt: now,
    })
    .where(
      and(eq(shareTransfers.id, row.id), eq(shareTransfers.status, row.status)),
    );
}

async function sendOut(
  db: Database,
  row: Row,
  kind: ShareTransferKind,
  provider: ShareTransferProvider,
  now: Date,
): Promise<void> {
  const collect = provider.collectToPlatform;
  const source = SOURCE[kind];
  if (!collect || !source) return;
  if (kind === 'recover') {
    // The business holds the share only once the sweep has finished delivering it.
    const [sweep] = await db
      .select({ status: shareTransfers.status })
      .from(shareTransfers)
      .where(
        and(
          eq(shareTransfers.tipId, row.tipId),
          eq(shareTransfers.kind, 'sweep'),
        ),
      );
    if (sweep?.status !== 'done') return postpone(db, row, now);
  }
  const accountRef = await accountOf(db, sideOf(row, source), provider);
  if (!accountRef) return postpone(db, row, now);
  if (kind === 'sweep') {
    // Transfers draw only on the available balance: until the tip has settled there, wait.
    try {
      const { availableMinor } = await provider.payoutBalance(
        accountRef,
        'NGN',
      );
      if (availableMinor < row.amountMinor) return postpone(db, row, now);
    } catch {
      return postpone(db, row, now);
    }
  }
  if (
    !(await claim(db, row, 'waiting', {
      status: 'out_sent',
      sentAt: now,
      attempts: row.attempts + 1,
    }))
  )
    return;
  let answer: Transfer;
  try {
    answer = await collect.call(provider, {
      accountRef,
      amountMinor: row.amountMinor,
      currency: 'NGN',
      idempotencyKey: shareOutKey(row.id),
      description: DESCRIPTION,
    });
  } catch (error) {
    if (!definitelyNotMoved(error)) return; // It may have moved: read back, never re-sent now.
    if (kind === 'recover') return recordGap(db, row, now);
    // Not there yet (pending settlement, or the account is in debt): wait and ask again.
    await claim(db, row, 'out_sent', {
      status: 'waiting',
      nextAttemptAt: backoff(row.attempts + 1, now),
    });
    return;
  }
  if (answer.status === 'paid')
    return confirmOut(db, row, answer.transferRef, now);
  await claim(db, row, 'out_sent', { outReference: answer.transferRef });
}

async function sendIn(
  db: Database,
  row: Row,
  kind: ShareTransferKind,
  provider: ShareTransferProvider,
  now: Date,
): Promise<void> {
  const send = provider.transferToAccount;
  if (!send || row.deliverMinor === null) return;
  if (row.deliverMinor === 0n) {
    await claim(db, row, 'out_paid', { status: 'done' });
    return;
  }
  const accountRef = await accountOf(
    db,
    sideOf(row, DESTINATION[kind]),
    provider,
  );
  if (!accountRef) return postpone(db, row, now);
  if (
    !(await claim(db, row, 'out_paid', {
      status: 'in_sent',
      sentAt: now,
      attempts: row.attempts + 1,
    }))
  )
    return;
  let answer: Transfer;
  try {
    answer = await send.call(provider, {
      accountRef,
      amountMinor: row.deliverMinor,
      currency: 'NGN',
      idempotencyKey: shareInKey(row.id),
      description: DESCRIPTION,
    });
  } catch (error) {
    if (!definitelyNotMoved(error)) return;
    // TipMe is holding the money: the same key is asked again later, and a person is told if it
    // keeps being refused.
    if (row.attempts + 1 >= IN_ATTEMPTS_BEFORE_REVIEW) {
      await claim(db, row, 'in_sent', { status: 'out_paid' });
      return toReview(
        db,
        row,
        now,
        'Our partner refused TipMe’s transfer on, again and again.',
      );
    }
    await claim(db, row, 'in_sent', {
      status: 'out_paid',
      nextAttemptAt: backoff(row.attempts + 1, now),
    });
    return;
  }
  await claim(
    db,
    row,
    'in_sent',
    answer.status === 'paid'
      ? { status: 'done', inReference: answer.transferRef }
      : { inReference: answer.transferRef },
  );
}

/** A leg whose answer was lost or pending: looked for by its key, never sent again blindly. */
async function readBack(
  db: Database,
  row: Row,
  kind: ShareTransferKind,
  provider: ShareTransferProvider,
  now: Date,
): Promise<void> {
  const find = provider.findPlatformCollection;
  if (!find) return;
  const out = row.status === 'out_sent';
  const side = out ? SOURCE[kind] : DESTINATION[kind];
  if (!side) return;
  const accountRef = await accountOf(db, sideOf(row, side), provider);
  if (!accountRef) return;
  const expected = out ? row.amountMinor : row.deliverMinor;
  const found = await find.call(
    provider,
    accountRef,
    out ? shareOutKey(row.id) : shareInKey(row.id),
  );
  if (
    found &&
    (found.amountMinor !== expected || found.currency !== row.currency)
  )
    return toReview(
      db,
      row,
      now,
      'Our partner shows this transfer with another amount or currency.',
    );
  if (found?.status === 'paid') {
    if (out) return confirmOut(db, row, found.transferRef, now);
    await claim(db, row, 'in_sent', {
      status: 'done',
      inReference: found.transferRef,
    });
    return;
  }
  if (found) {
    // Still pending at the partner: look again later.
    await claim(db, row, row.status as ShareTransferStatus, { sentAt: now });
    return;
  }
  const sentAt = row.sentAt?.getTime() ?? row.updatedAt.getTime();
  if (now.getTime() - sentAt < GIVE_UP_AFTER_MS) return;
  // Not there half an hour on: it never moved. Asked again with the SAME key, so a late arrival
  // can only ever be answered as the one transfer.
  await claim(db, row, row.status as ShareTransferStatus, {
    status: out ? 'waiting' : 'out_paid',
    nextAttemptAt: now,
  });
}

/**
 * The worker's run (every reconcile, with BUSINESS_SHARES_ENABLED): each share movement due now is
 * taken one step further. A sweep waits `settleWaitMs` after its tip was paid before it is even
 * tried (partner question (e): the settlement delay for naira charges), and then until the staff
 * member's available balance holds it. One row's trouble never stops the others.
 */
export async function runShareTransfers(
  db: Database,
  input: {
    provider: ShareTransferProvider;
    now: Date;
    settleWaitMs: number;
    readBackAfterMs?: number;
    limit?: number;
    /** Only these kinds (the worker: fee returns alone while shares are off). */
    kinds?: readonly ShareTransferKind[];
  },
): Promise<{ checked: number; failed: number }> {
  const { now, provider } = input;
  const settledBefore = new Date(now.getTime() - input.settleWaitMs);
  const readBackBefore = new Date(
    now.getTime() - (input.readBackAfterMs ?? READ_BACK_AFTER_MS),
  );
  const rows = await guarded(() =>
    db
      .select()
      .from(shareTransfers)
      .where(
        and(
          eq(shareTransfers.provider, recordedProviderName(provider.name)),
          ...(input.kinds
            ? [inArray(shareTransfers.kind, [...input.kinds])]
            : []),
          or(
            and(
              eq(shareTransfers.status, 'waiting'),
              lte(shareTransfers.nextAttemptAt, now),
              or(
                sql`${shareTransfers.kind} <> 'sweep'`,
                lte(shareTransfers.createdAt, settledBefore),
              ),
            ),
            and(
              eq(shareTransfers.status, 'out_paid'),
              lte(shareTransfers.nextAttemptAt, now),
            ),
            and(
              inArray(shareTransfers.status, ['out_sent', 'in_sent']),
              lte(shareTransfers.sentAt, readBackBefore),
            ),
          ),
        ),
      )
      .orderBy(asc(shareTransfers.createdAt), asc(shareTransfers.id))
      .limit(input.limit ?? 100),
  );
  let failed = 0;
  for (const row of rows) {
    try {
      await step(db, row, provider, now);
      // The second leg goes straight after a first one confirmed now (the sandbox's S3 order).
      const [after] = await db
        .select()
        .from(shareTransfers)
        .where(eq(shareTransfers.id, row.id));
      if (after && after.status === 'out_paid' && row.status !== 'out_paid')
        await step(db, after, provider, now);
    } catch {
      failed += 1;
    }
  }
  return { checked: rows.length, failed };
}

/** What a business's owners see beside its balance: shares on their way, and what is held back. */
export function businessShareMoney(
  db: Database,
  businessId: string,
): Promise<{ onTheWayMinor: bigint; heldBackMinor: bigint }> {
  return guarded(async () => {
    const result = await db.execute<{ on_way: string; held: string }>(sql`
      SELECT
        (SELECT COALESCE(SUM(COALESCE(deliver_minor, amount_minor)), 0) FROM share_transfers
          WHERE business_id = ${businessId} AND kind = 'sweep'
            AND status IN ('waiting', 'out_sent', 'out_paid', 'in_sent'))::text AS on_way,
        (SELECT COALESCE(SUM(remaining_minor), 0) FROM share_holdbacks
          WHERE business_id = ${businessId} AND remaining_minor > 0)::text AS held`);
    const row = result.rows[0];
    return {
      onTheWayMinor: BigInt(row?.on_way ?? '0'),
      heldBackMinor: BigInt(row?.held ?? '0'),
    };
  });
}
