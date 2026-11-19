// "You collect": recovery rules for refunds and disputes. Pure functions; no I/O, no timing.
// Amounts are integer minor units. Spec section 6.

export type ShareWhere =
  | { state: 'held'; heldMinor: bigint }
  | { state: 'moved'; inBalanceMinor: bigint }
  | { state: 'in_flight' };

export type CollectRefundPlan =
  | { kind: 'cancel_held' }
  | { kind: 'take_back'; backMinor: bigint }
  | { kind: 'staff_decides'; gapMinor: bigint }
  | { kind: 'wait' };

const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);

/**
 * What must happen to the recipient's share for a refund. This says WHAT, never WHEN.
 *
 * `cancel_held` means the held share is to be cancelled. It does not mean "cancel now": the caller
 * (Task 10) holds the share when the refund is requested, cancels it only once the refund is paid,
 * and restores it if the refund is refused. A share in flight (`sent` or `unknown`) always waits
 * for the read-back, so nothing is cancelled under a transfer that may land.
 */
export function collectRefundPlan(i: {
  refundMinor: bigint;
  share: ShareWhere;
}): CollectRefundPlan {
  const { share, refundMinor } = i;
  if (share.state === 'in_flight') return { kind: 'wait' };
  if (share.state === 'held') return { kind: 'cancel_held' };
  if (share.inBalanceMinor >= refundMinor) {
    return { kind: 'take_back', backMinor: refundMinor };
  }
  return {
    kind: 'staff_decides',
    gapMinor: refundMinor - share.inBalanceMinor,
  };
}

/**
 * Recovery for a lost dispute: the held share first, then what is still in the recipient's partner
 * balance, then TipMe absorbs the rest. The recipient never gives back more than `netMinor`
 * (the 14 Nov rule). An in-flight transfer waits for the read-back.
 */
export function disputeRecovery(i: {
  disputedMinor: bigint;
  netMinor: bigint;
  share: ShareWhere;
}):
  | { fromHeldMinor: bigint; backMinor: bigint; absorbedMinor: bigint }
  | { wait: true } {
  const { share, disputedMinor, netMinor } = i;
  if (share.state === 'in_flight') return { wait: true };
  const cap = min(disputedMinor, netMinor);
  const fromHeldMinor = share.state === 'held' ? min(share.heldMinor, cap) : 0n;
  const backMinor =
    share.state === 'moved' ? min(share.inBalanceMinor, cap) : 0n;
  return {
    fromHeldMinor,
    backMinor,
    absorbedMinor: disputedMinor - fromHeldMinor - backMinor,
  };
}
