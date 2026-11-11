import { z } from 'zod';
import { opsReasonSchema } from './ops.js';

/**
 * Paid Pro (ADR-0015; the owner's decisions of 4, 5 and 9 Nov 2026). Amounts are kobo, sent as
 * strings of digits; the server is the only source of the price.
 */

/** ₦100 to ₦1,000,000, whole naira (the owner, 5 Nov 2026). */
export const PRO_PRICE_MIN_MINOR = 10_000n;
export const PRO_PRICE_MAX_MINOR = 100_000_000n;

/** Whether a kobo amount is an allowed Pro price. */
export function isAllowedProPrice(amountMinor: bigint): boolean {
  return (
    amountMinor >= PRO_PRICE_MIN_MINOR &&
    amountMinor <= PRO_PRICE_MAX_MINOR &&
    amountMinor % 100n === 0n
  );
}

const kobo = z
  .string()
  .regex(/^[1-9][0-9]{0,11}$/)
  .refine(
    (value) => /^[0-9]+$/.test(value) && isAllowedProPrice(BigInt(value)),
  );

/** `GET /v1/pro/price`: what a month of Pro costs today. */
export interface ProPrice {
  amountMinor: string;
  currency: 'NGN';
  interval: 'month';
}

/** One row of the price history, for staff. */
export interface OpsProPriceRow {
  id: string;
  amountMinor: string;
  currency: 'NGN';
  effectiveFrom: string;
  /** Null for the launch price, which a migration set. */
  setBy: string | null;
  approvedBy: string | null;
  reason: string;
  createdAt: string;
}

/** `GET /v1/ops/pro-price`. */
export interface OpsProPrice {
  current: OpsProPriceRow | null;
  history: OpsProPriceRow[];
  limits: { minMinor: string; maxMinor: string };
  /** A change already waiting for a second person, if any. */
  waitingRequestId: string | null;
}

/** `POST /v1/ops/pro-price`: a new price for new months, with a reason. */
export const opsProPriceChangeSchema = opsReasonSchema
  .extend({ amountMinor: kobo })
  .strict();
export type OpsProPriceChangeRequest = z.infer<typeof opsProPriceChangeSchema>;

/** `POST /v1/me/pro/purchases`: only the amount the person saw, to refuse a changed price. */
export const proPurchaseRequestSchema = z
  .object({
    expectedAmountMinor: z.string().regex(/^[1-9][0-9]{0,11}$/),
  })
  .strict();
export type ProPurchaseRequest = z.infer<typeof proPurchaseRequestSchema>;

export const PRO_PURCHASE_STATUSES = [
  'PENDING',
  'COLLECTING',
  'UNKNOWN',
  'PAID',
  'FAILED',
  'EXPIRED',
  'REVIEW',
] as const;
export type ProPurchaseStatus = (typeof PRO_PURCHASE_STATUSES)[number];

/** One purchase, for its owner. The checkout URL is there only while it can be paid. */
export interface ProPurchase {
  purchaseId: string;
  status: ProPurchaseStatus;
  amountMinor: string;
  currency: 'NGN';
  checkoutUrl: string | null;
  expiresAt: string | null;
  paidAt: string | null;
}

/** `GET /v1/me/pro`: the page's plan, why, the months paid, and how to buy the next one. */
export interface MyPro {
  plan: 'free' | 'pro';
  source: 'staff' | 'paid' | null;
  current: {
    startsAt: string;
    endsAt: string;
    graceEndsAt: string;
    paidBy: 'card' | 'bank_transfer' | 'balance' | 'saved_card';
  } | null;
  next: { startsAt: string; endsAt: string } | null;
  openPurchase: ProPurchase | null;
  price: ProPrice | null;
  methods: 'card'[];
  /** Buying is open on this copy (PRO_BILLING_ENABLED). */
  billingOn: boolean;
}
