import type { OpsIssue } from '@tipme/contracts';

/*
 * Taking back a refunded or charged-back tip from its issue (`tip.reverse`, 16 Nov 2026). The same
 * rule as the API's `tipReversalTarget`: an open `payment_reversed` issue naming the partner's
 * refund or dispute; a refund only once the partner says it is paid, for what it gave back; a
 * dispute for the amount staff read on the partner's dashboard. The API decides again. Type-only
 * imports, so it can be tested alone; never the partner's name.
 */

export type TipReverseView =
  | { kind: 'none' }
  | { kind: 'cannot'; words: string }
  | { kind: 'wait'; words: string }
  | { kind: 'refund'; refundedMinor: string }
  | { kind: 'dispute' };

export function tipReverseView(
  issue: Pick<OpsIssue, 'kind' | 'status' | 'subject'>,
): TipReverseView {
  if (issue.kind !== 'payment_reversed' || issue.status !== 'open')
    return { kind: 'none' };
  const { tipId, partnerReversalId, refundState, refundedMinor } =
    issue.subject;
  if (!tipId || !partnerReversalId)
    return {
      kind: 'cannot',
      words:
        'This report names no refund or dispute, so it can’t be taken back from TipMe. Settle it with our payment partner, then resolve the issue by hand.',
    };
  if (partnerReversalId.startsWith('dispute.')) return { kind: 'dispute' };
  if (refundState === 'failed')
    return {
      kind: 'wait',
      words:
        'Our payment partner says this refund failed: nothing moved, so there is nothing to take back. Resolve the issue.',
    };
  if (refundState !== 'paid')
    return {
      kind: 'wait',
      words:
        'Our payment partner hasn’t said this refund is paid yet. It can be taken back once they do; this page shows it when they tell TipMe.',
    };
  if (!refundedMinor)
    return {
      kind: 'wait',
      words:
        'Our payment partner says this refund is paid, but TipMe couldn’t read how much it gave back. Check their dashboard, then resolve the issue by hand.',
    };
  return { kind: 'refund', refundedMinor };
}
