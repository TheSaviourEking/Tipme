import { bachsEnvironment, recordedProviderName } from '@tipme/contracts';
import { sql } from 'drizzle-orm';
import type { Database } from '../client.js';
import type { IssueSubject } from '../schema.js';
import { matchCollectAttempt } from './collect-transfers.js';
import { moneyText } from './collect-reserve.js';
import { guarded } from './errors.js';
import { openIssue } from './issues.js';

/*
 * You collect's daily reconciliation (plan Task 11, spec §7; rulings P17, P18). Read-only towards the
 * partner and towards our own rows: it only opens `collect_recon_mismatch` issues (one per finding,
 * by dedupe key, so a repeated run raises nothing twice) and reports its totals. Three checks:
 *
 * 1. Transfers. For each You collect account with activity in the last 3 days, every transfer the
 *    partner lists on it (all pages, P17) against our `collect_transfers` by `transfer_group` (our
 *    idempotency key): a paid row of ours it doesn't list (missing), one it lists with another amount
 *    or currency (different), and a `tipme-collect-` transfer we have no row for, or one we hold as
 *    never moved (extra). Rows still in flight or in review are the read-back's and staff's.
 * 2. Disputes. The partner's disputes since then against `disputes`: one on a You collect payment we
 *    don't have (a lost webhook), or ours with another amount, currency or final status.
 * 3. TipMe's own balance against the ledger (P18). There is no partner balance-activity read in the
 *    adapter, so the activity is what the partner reported and TipMe stored: a refund the partner
 *    paid (`refunded_minor`) with no `collect_refund.<id>` booking (an unexpected `refund.paid`,
 *    Task 10's `paid_unbooked`, overstates TipMe's own money), a dispute fee or loss with no posting,
 *    and a paid transfer with no posting.
 */

const WINDOW_MS = 3 * 24 * 3_600_000;
const COLLECT_GROUP = /^tipme-collect-/;

export interface CollectReconReader {
  name: string;
  listAccountTransfers(accountRef: string): Promise<
    {
      transferRef: string;
      status: 'paid' | 'pending';
      amountMinor: bigint;
      currency: string;
      group: string | null;
    }[]
  >;
  listDisputes(since: Date): Promise<
    {
      partnerDisputeId: string;
      status: string;
      amountMinor: bigint;
      currency: string;
      chargeReference: string | null;
    }[]
  >;
}

export interface CollectReconResult {
  /** Transfers and disputes compared. */
  checked: number;
  /** Findings this run (each is one open issue, opened once). */
  mismatches: number;
  /** Accounts whose transfers could not be read (tried again tomorrow). */
  unreadable: number;
}

type OurTransfer = {
  id: string;
  tip_id: string;
  profile_id: string;
  kind: string;
  account_reference: string;
  status: string;
  amount_minor: string;
  currency: string;
  idempotency_key: string;
};

export function reconcileCollect(
  db: Database,
  i: { provider: CollectReconReader; day: Date },
): Promise<CollectReconResult> {
  return guarded(async () => {
    const since = new Date(i.day.getTime() - WINDOW_MS);
    const now = i.day;
    let checked = 0;
    let mismatches = 0;
    let unreadable = 0;
    const raise = async (
      key: string,
      subject: IssueSubject,
      note: string,
    ): Promise<void> => {
      mismatches += 1;
      await openIssue(db, {
        dedupeKey: `collect_recon.${key}`,
        kind: 'collect_recon_mismatch',
        subject,
        note,
        now,
      });
    };
    const money = (minor: bigint | string, currency: string) =>
      moneyText(BigInt(minor), currency);

    // 1. Transfers, per account with recent activity.
    const provider = recordedProviderName(i.provider.name);
    const environment = bachsEnvironment(i.provider.name);
    const envFilter = environment
      ? sql`AND c.environment = ${environment}`
      : sql``;
    const accounts = (
      await db.execute<{ account_reference: string }>(sql`
        SELECT DISTINCT c.account_reference FROM collect_transfers c
         WHERE c.account_reference IS NOT NULL AND c.provider = ${provider} ${envFilter}
           AND (c.created_at >= ${since.toISOString()}::timestamptz
                OR c.updated_at >= ${since.toISOString()}::timestamptz)
         ORDER BY c.account_reference`)
    ).rows.map((r) => r.account_reference);
    for (const account of accounts) {
      let listed: Awaited<
        ReturnType<CollectReconReader['listAccountTransfers']>
      >;
      try {
        listed = await i.provider.listAccountTransfers(account);
      } catch {
        // Never a partial list: absence would prove nothing. Tomorrow's run reads it again.
        unreadable += 1;
        continue;
      }
      const ours = (
        await db.execute<OurTransfer>(sql`
          SELECT c.id, c.tip_id, c.profile_id, c.kind, c.account_reference, c.status,
                 c.amount_minor::text AS amount_minor, c.currency, c.idempotency_key
            FROM collect_transfers c WHERE c.account_reference = ${account}`)
      ).rows;
      const byGroup = new Map(listed.map((t) => [t.group, t]));
      for (const row of ours) {
        if (row.status !== 'paid') continue;
        checked += 1;
        const theirs = byGroup.get(row.idempotency_key);
        if (!theirs)
          await raise(
            `transfer.${row.idempotency_key}.missing`,
            { tipId: row.tip_id, profileId: row.profile_id },
            `Transfer ${row.id} (group ${row.idempotency_key}, ${money(row.amount_minor, row.currency)}) is paid in TipMe's records but not listed on account ${account} at the partner.`,
          );
        else if (
          theirs.amountMinor !== BigInt(row.amount_minor) ||
          theirs.currency !== row.currency
        )
          await raise(
            `transfer.${row.idempotency_key}.amount`,
            { tipId: row.tip_id, profileId: row.profile_id },
            `Transfer ${row.id} (group ${row.idempotency_key}) is ${money(row.amount_minor, row.currency)} in TipMe's records; the partner lists ${theirs.transferRef} for ${money(theirs.amountMinor, theirs.currency)}.`,
          );
      }
      const ourKeys = new Map(ours.map((r) => [r.idempotency_key, r]));
      for (const theirs of listed) {
        if (!theirs.group || !COLLECT_GROUP.test(theirs.group)) continue;
        const row =
          ourKeys.get(theirs.group) ??
          (
            await db.execute<OurTransfer>(sql`
              SELECT c.id, c.tip_id, c.profile_id, c.kind, c.account_reference, c.status,
                     c.amount_minor::text AS amount_minor, c.currency, c.idempotency_key
                FROM collect_transfers c WHERE c.idempotency_key = ${theirs.group}`)
          ).rows[0];
        if (row?.status === 'paid' && row.account_reference === account)
          continue;
        // Sent, unknown or in review: the read-back or staff settle it.
        if (row && ['sent', 'unknown', 'review'].includes(row.status)) continue;
        checked += 1;
        const profileId =
          row?.profile_id ??
          (
            await db.execute<{ profile_id: string | null }>(sql`
              SELECT profile_id FROM payment_accounts
               WHERE provider_account_reference = ${account} LIMIT 1`)
          ).rows[0]?.profile_id ??
          undefined;
        await raise(
          `transfer.${theirs.group}.extra`,
          row
            ? { tipId: row.tip_id, profileId: row.profile_id }
            : profileId
              ? { profileId }
              : {},
          row
            ? `The partner lists ${theirs.transferRef} (group ${theirs.group}, ${money(theirs.amountMinor, theirs.currency)}, ${theirs.status}) on account ${account}, but TipMe has transfer ${row.id} as ${row.status}${row.account_reference !== account ? ` on account ${row.account_reference}` : ''}.`
            : `The partner lists ${theirs.transferRef} (group ${theirs.group}, ${money(theirs.amountMinor, theirs.currency)}, ${theirs.status}) on account ${account}, and TipMe has no record of it.`,
        );
      }
    }

    // 2. Disputes.
    const theirDisputes = await i.provider.listDisputes(since);
    for (const theirs of theirDisputes) {
      const [ours] = (
        await db.execute<{
          id: string;
          tip_id: string;
          amount_minor: string;
          currency: string;
          status: string;
        }>(sql`
          SELECT id, tip_id, amount_minor::text AS amount_minor, currency, status
            FROM disputes WHERE partner_dispute_id = ${theirs.partnerDisputeId}`)
      ).rows;
      if (!ours) {
        // Only a dispute on a You collect payment is ours to know (a Pro payment's is not, P5).
        const attemptId = theirs.chargeReference
          ? await matchCollectAttempt(db, {
              providerReference: null,
              operationReference: null,
              chargeReference: theirs.chargeReference,
            })
          : null;
        if (!attemptId) continue;
        checked += 1;
        await raise(
          `dispute.${theirs.partnerDisputeId}.unknown`,
          { attemptId },
          `The partner has dispute ${theirs.partnerDisputeId} (${money(theirs.amountMinor, theirs.currency)}, ${theirs.status}) on a You collect payment, and TipMe has no record of it: nothing is held or booked. Its events may not have arrived.`,
        );
        continue;
      }
      checked += 1;
      const final = ['won', 'lost', 'closed'].includes(theirs.status);
      if (
        BigInt(ours.amount_minor) !== theirs.amountMinor ||
        ours.currency !== theirs.currency
      )
        await raise(
          `dispute.${theirs.partnerDisputeId}.amount`,
          { tipId: ours.tip_id },
          `Dispute ${theirs.partnerDisputeId} is ${money(ours.amount_minor, ours.currency)} in TipMe's records; the partner has ${money(theirs.amountMinor, theirs.currency)}.`,
        );
      else if (final && ours.status !== theirs.status)
        await raise(
          `dispute.${theirs.partnerDisputeId}.status.${theirs.status}`,
          { tipId: ours.tip_id },
          `Dispute ${theirs.partnerDisputeId} is ${theirs.status} at the partner and ${ours.status} in TipMe's records.`,
        );
    }

    // 3. TipMe's own balance against the ledger (P18).
    const unbookedRefunds = (
      await db.execute<{
        id: string;
        tip_id: string;
        status: string;
        refunded: string;
        currency: string;
        reference: string | null;
      }>(sql`
        SELECT r.id, r.tip_id, r.status, r.refunded_minor::text AS refunded, r.currency,
               r.provider_refund_reference AS reference
          FROM tip_refunds r
         WHERE r.collect_plan IS NOT NULL AND r.refunded_minor IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ledger_transactions lt
                            WHERE lt.operation_key = 'collect_refund.' || r.id::text)`)
    ).rows;
    for (const r of unbookedRefunds)
      await raise(
        `refund_unbooked.${r.id}`,
        { tipId: r.tip_id },
        `The partner refunded ${money(r.refunded, r.currency)} of tip ${r.tip_id} from TipMe's balance${r.reference ? ` (${r.reference})` : ''}, and the ledger has no booking for it (refund ${r.id} is ${r.status}). TipMe's own money reads higher than the partner holds by that much until it is booked.`,
      );
    const unbookedFees = (
      await db.execute<{
        id: string;
        tip_id: string;
        partner_dispute_id: string;
        fee: string;
        fee_currency: string;
      }>(sql`
        SELECT d.id, d.tip_id, d.partner_dispute_id, d.fee_minor::text AS fee, d.fee_currency
          FROM disputes d
         WHERE d.fee_minor > 0 AND d.fee_currency IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ledger_transactions lt
                            WHERE lt.operation_key = 'dispute_fee.' || d.id::text)`)
    ).rows;
    for (const d of unbookedFees)
      await raise(
        `dispute_fee.${d.id}`,
        { tipId: d.tip_id },
        `The partner charged a ${money(d.fee, d.fee_currency)} fee for dispute ${d.partner_dispute_id} from TipMe's balance, and the ledger has no booking for it.`,
      );
    const unbookedLosses = (
      await db.execute<{
        id: string;
        tip_id: string;
        partner_dispute_id: string;
        amount: string;
        currency: string;
      }>(sql`
        SELECT d.id, d.tip_id, d.partner_dispute_id, d.amount_minor::text AS amount, d.currency
          FROM disputes d
         WHERE d.status = 'lost' AND d.settled_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM ledger_transactions lt
                            WHERE lt.operation_key = 'dispute_loss.' || d.id::text)`)
    ).rows;
    for (const d of unbookedLosses)
      await raise(
        `dispute_loss.${d.id}`,
        { tipId: d.tip_id },
        `Dispute ${d.partner_dispute_id} (${money(d.amount, d.currency)}) was lost and settled, and the ledger has no booking for the loss.`,
      );
    const unbookedTransfers = (
      await db.execute<{
        id: string;
        tip_id: string;
        profile_id: string;
        amount: string;
        currency: string;
        idempotency_key: string;
      }>(sql`
        SELECT c.id, c.tip_id, c.profile_id, c.amount_minor::text AS amount, c.currency,
               c.idempotency_key
          FROM collect_transfers c
         WHERE c.status = 'paid' AND c.paid_at >= ${since.toISOString()}::timestamptz
           AND NOT EXISTS (SELECT 1 FROM ledger_transactions lt
                            WHERE lt.operation_key = 'collect_transfer.' || c.id::text)`)
    ).rows;
    for (const c of unbookedTransfers)
      await raise(
        `transfer_unbooked.${c.id}`,
        { tipId: c.tip_id, profileId: c.profile_id },
        `Transfer ${c.id} (group ${c.idempotency_key}, ${money(c.amount, c.currency)}) is paid, and the ledger has no booking for it.`,
      );
    return { checked, mismatches, unreadable };
  });
}

export type CollectTipWaiting = 'payment' | 'share' | 'dispute';

/**
 * Whether a You collect tip is fully reconciled (spec §7): its payment verified and booked, its share
 * `paid` with its posting or `cancelled` with the reversal that took it, and no dispute open or
 * unsettled. `waiting` names what is not there yet.
 */
export function collectTipReconciliation(
  db: Database,
  tipId: string,
): Promise<{ reconciled: boolean; waiting: CollectTipWaiting[] }> {
  return guarded(async () => {
    const [row] = (
      await db.execute<{
        payment: boolean;
        share: boolean;
        disputed: boolean;
      }>(sql`
        SELECT
          (EXISTS (SELECT 1 FROM payment_attempts a JOIN tips t ON t.intent_id = a.intent_id
                    WHERE t.id = ${tipId} AND a.status = 'VERIFIED_SUCCEEDED')
           AND EXISTS (SELECT 1 FROM ledger_transactions lt
                        WHERE lt.tip_id = ${tipId} AND lt.operation_type = 'payment')) AS payment,
          COALESCE((SELECT (s.status = 'paid' AND EXISTS (
                              SELECT 1 FROM ledger_transactions lt
                               WHERE lt.operation_key = 'collect_transfer.' || s.id::text))
                        OR (s.status = 'cancelled' AND EXISTS (
                              SELECT 1 FROM ledger_transactions lt
                               WHERE lt.tip_id = ${tipId} AND lt.operation_type = 'reversal'))
                      FROM collect_transfers s WHERE s.tip_id = ${tipId} AND s.kind = 'share'),
                   true) AS share,
          EXISTS (SELECT 1 FROM disputes d
                   WHERE d.tip_id = ${tipId}
                     AND (d.status IN ('open', 'responded')
                          OR (d.status IN ('lost', 'closed') AND d.settled_at IS NULL))) AS disputed`)
    ).rows;
    const waiting: CollectTipWaiting[] = [];
    if (!row?.payment) waiting.push('payment');
    if (!row?.share) waiting.push('share');
    if (row?.disputed) waiting.push('dispute');
    return { reconciled: waiting.length === 0, waiting };
  });
}
