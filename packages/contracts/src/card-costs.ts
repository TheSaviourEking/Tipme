import { z } from 'zod';
import { opsReasonSchema } from './ops.js';

/**
 * What a card payment costs TipMe (owner, 26 Nov 2026: an ops screen, not env settings): the card
 * fee rate, the fixed 3D Secure cost and a safety margin. Card is offered on a tip only when
 * TipMe's share covers rate × amount + fixed + margin (profit guards, Part 2). Amounts are kobo as
 * strings of digits; the screen takes naira and sends kobo. Staff only: users never see these.
 */

/** Kobo as a string of digits, 0 or more, no leading zeros. */
const kobo = z.string().regex(/^(0|[1-9][0-9]{0,11})$/);

/** One stored setting, for staff. */
export interface OpsCardCostsRow {
  id: string;
  rateBps: number;
  fixedMinor: string;
  marginMinor: string;
  effectiveFrom: string;
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  createdAt: string;
}

/**
 * `GET /v1/ops/card-costs`: the card cost in force (from the setting, or the coded defaults when
 * none is stored: 2% + ₦45, margin ₦15), its history, and a change waiting for a second person.
 */
export interface OpsCardCosts {
  current: {
    rateBps: number;
    fixedMinor: string;
    marginMinor: string;
    source: 'setting' | 'default';
    effectiveFrom: string | null;
  };
  history: OpsCardCostsRow[];
  waitingRequestId: string | null;
}

/** `POST /v1/ops/card-costs`: a new card cost from now, with a reason. */
export const opsCardCostsChangeSchema = opsReasonSchema
  .extend({
    rateBps: z.number().int().min(0).max(10000),
    fixedMinor: kobo,
    marginMinor: kobo,
  })
  .strict();
export type OpsCardCostsChangeRequest = z.infer<
  typeof opsCardCostsChangeSchema
>;
