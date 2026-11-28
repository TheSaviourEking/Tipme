import type { DashboardSummary } from '@tipme/contracts';
import { FEE_WAIVER_RECIPIENT_COPY } from '@tipme/contracts/copy';
import { untilLabel } from './fee-waiver-dates.ts';

/**
 * The dashboard's "TipMe is covering the fee on your tips" line (spec 2026-11-23 §7, W17), with
 * "until 31 Jan" when the waiver has an end date. Null when there is nothing to say: no waiver, or
 * an answer without the field.
 */
export function tipsCoveredLine(
  waiver: DashboardSummary['tipFeeWaiver'] | undefined,
  now: Date = new Date(),
): string | null {
  if (!waiver) return null;
  return FEE_WAIVER_RECIPIENT_COPY.tipsCovered(
    waiver.endsAt === null ? null : untilLabel(waiver.endsAt, now),
  );
}
