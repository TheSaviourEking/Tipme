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

/** What a month of Pro costs today. */
export interface ProPrice {
  amountMinor: string;
  currency: 'NGN';
  interval: 'month';
}

/**
 * `GET /v1/pro/price`, for anyone: the price, and whether buying is switched on on this copy
 * (PRO_BILLING_ENABLED), so the /pro page can say "Get Pro" or "coming soon to buy" before anyone
 * signs in. Whether this person's page can buy is `MyPro.billingOn`.
 */
export interface PublicProPrice extends ProPrice {
  billingOn: boolean;
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
  /** Which Pro the price is for (Business Pro, plan Task A5). */
  plan: 'personal' | 'business';
}

/** `GET /v1/ops/pro-price` and, for Business Pro, `GET /v1/ops/business-pro-price`. */
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

/**
 * `POST /v1/me/pro/purchases`: the amount the person saw (to refuse a changed price) and how they
 * pay. `balance` needs PRO_PAY_FROM_BALANCE; `autoRenew` (card only) needs PRO_AUTO_RENEW.
 */
export const proPurchaseRequestSchema = z
  .object({
    expectedAmountMinor: z.string().regex(/^[1-9][0-9]{0,11}$/),
    method: z.enum(['card', 'balance']).optional(),
    autoRenew: z.boolean().optional(),
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
  /** `balance` only with PRO_PAY_FROM_BALANCE on. */
  methods: ('card' | 'balance')[];
  /** Buying is open on this copy (PRO_BILLING_ENABLED). */
  billingOn: boolean;
  /**
   * Auto-renew on a saved card (PRO_AUTO_RENEW). `available`: the tick can be offered on a card
   * checkout. `on`: a saved card will be charged a day before the month ends.
   */
  autoRenew: { available: boolean; on: boolean };
}

/** `POST /v1/me/pro/auto-renew/off`: always allowed. */
export interface ProAutoRenew {
  on: boolean;
}

/** One Pro payment of a page, for staff deciding a refund (plan Task 9). */
export interface OpsProPayment {
  purchaseId: string;
  amountMinor: string;
  currency: 'NGN';
  paidAt: string | null;
  paidBy: 'card' | 'bank_transfer' | 'balance' | 'saved_card' | null;
  refundable: boolean;
  /** Why not, or that it can be, in plain words. */
  words: string;
  refund: {
    status: 'REQUESTED' | 'PROCESSING' | 'UNKNOWN' | 'PAID' | 'FAILED';
  } | null;
}

/** `POST /v1/ops/pro/purchases/:purchaseId/refund`: the member's request, in staff's words. */
export const opsProRefundSchema = opsReasonSchema.strict();
export type OpsProRefundRequest = z.infer<typeof opsProRefundSchema>;
