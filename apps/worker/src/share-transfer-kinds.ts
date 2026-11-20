import type { ShareTransferKind } from '@tipme/database';

/**
 * Which money moves between partner accounts the worker runs. Fee returns always move: on a
 * chargeback TipMe always sends its fee back to the person (owner, 14 Nov 2026), whatever the
 * switches. A business's shares (sweeps, recoveries, held-back repayments, and a collect tip's share
 * held on TipMe's own account, `collect_sweep`) move only while the `business` and `business_shares`
 * switches are on. `undefined` means every kind.
 */
export function shareTransferKinds({
  sharesOn,
}: {
  sharesOn: boolean;
}): readonly ShareTransferKind[] | undefined {
  return sharesOn ? undefined : ['fee_return'];
}
