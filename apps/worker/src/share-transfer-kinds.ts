import type { ShareTransferKind } from '@tipme/database';

/**
 * Which money moves between partner accounts the worker runs. Fee returns always move: on a
 * chargeback TipMe always sends its fee back to the person (owner, 14 Nov 2026), whatever the
 * switches. So does You collect's business money (final review I2): a collect tip's business share
 * held on TipMe's own account (`collect_sweep`), a lost dispute's or refund's pull-back of it
 * (`collect_recover`), and a failed refund's pull-back returned (`collect_return`). It is money
 * TipMe already holds for the business or is owed back, so turning `business` or `business_shares`
 * off stops new shares at the quote, never this. A business's own option B shares (sweeps,
 * recoveries, held-back repayments) move only while both switches are on. `undefined` means every
 * kind.
 */
export function shareTransferKinds({
  sharesOn,
}: {
  sharesOn: boolean;
}): readonly ShareTransferKind[] | undefined {
  return sharesOn
    ? undefined
    : ['fee_return', 'collect_sweep', 'collect_recover', 'collect_return'];
}
