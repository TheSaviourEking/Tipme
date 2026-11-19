import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  DisputeEvent,
  DisputeStatus,
  NormalizedProviderEvent,
  WebhookVerification,
} from '../provider.js';
import { decimalToMinor } from './money.js';
import { payoutFailureReason } from './payouts.js';

const SIGNATURE_V2_HEADER = 'x-bachs-signature-v2';
const LEGACY_SIGNATURE_HEADER = 'x-bachs-signature';
const LEGACY_TIMESTAMP_HEADER = 'x-bachs-timestamp';
const SIGNATURE_TOLERANCE_SECONDS = 300;
const SUPPORTED_EVENT_TYPES = new Set([
  'collection.succeeded',
  'collection.failed',
  'collection.underpaid',
  'checkout.completed',
  'account.updated',
  'capability.updated',
  'payout.paid',
  'payout.failed',
  // Auto-renew (plan Task 10): a card saved on TipMe's own account while paying.
  'payment_method.saved',
]);

const eventEnvelopeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(200),
  // When the event occurred (the partner's event pages); only dispute events read it.
  created_at: z.string().max(64).optional(),
  organization_id: z.string().nullable().optional(),
  account: z.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()),
});

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const entry = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  if (Array.isArray(entry)) return entry.length === 1 ? entry[0] : undefined;
  return entry;
}

function verifyDigest(
  rawBody: Buffer,
  timestamp: string,
  signatures: string[],
  secrets: readonly string[],
): boolean {
  const expectedTimestamp = Number(timestamp);
  if (!Number.isSafeInteger(expectedTimestamp) || expectedTimestamp <= 0)
    return false;

  const signedPayload = Buffer.concat([
    Buffer.from(`${timestamp}.`, 'utf8'),
    rawBody,
  ]);
  let matched = false;
  for (const secret of secrets) {
    const expected = createHmac('sha256', secret)
      .update(signedPayload)
      .digest();
    for (const signature of signatures) {
      if (!/^[a-f0-9]{64}$/i.test(signature)) continue;
      const actual = Buffer.from(signature, 'hex');
      matched = timingSafeEqual(expected, actual) || matched;
    }
  }
  return matched;
}

/** An NGN decimal in a payout event; anything else is left out for the caller to judge. */
function eventMoney(
  value: unknown,
  currency: string | null,
): bigint | undefined {
  if (typeof value !== 'string' || currency !== 'NGN') return undefined;
  try {
    return decimalToMinor(value, 'NGN');
  } catch {
    return undefined;
  }
}

function verifySignature(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: readonly string[],
  now: Date,
): WebhookVerification<NormalizedProviderEvent> | null {
  const v2Header = headerValue(headers, SIGNATURE_V2_HEADER);
  let timestamp: string | undefined;
  let signatures: string[] = [];

  if (v2Header !== undefined) {
    if (v2Header.length > 1024) return { ok: false, reason: 'malformed' };
    for (const part of v2Header.split(',')) {
      const trimmed = part.trim();
      if (trimmed.startsWith('t=')) {
        if (timestamp !== undefined) return { ok: false, reason: 'malformed' };
        timestamp = trimmed.slice(2);
      } else if (trimmed.startsWith('v1=')) {
        signatures.push(trimmed.slice(3));
        if (signatures.length > 8) return { ok: false, reason: 'malformed' };
      }
    }
    if (!timestamp || signatures.length === 0)
      return { ok: false, reason: 'malformed' };
  } else {
    const legacyTimestamp = headerValue(headers, LEGACY_TIMESTAMP_HEADER);
    const legacySignature = headerValue(headers, LEGACY_SIGNATURE_HEADER);
    if (!legacyTimestamp || !legacySignature)
      return { ok: false, reason: 'missing_signature' };
    timestamp = legacyTimestamp;
    signatures = [legacySignature];
  }

  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: 'malformed' };
  const sentAtSeconds = Number(timestamp);
  if (!Number.isSafeInteger(sentAtSeconds) || sentAtSeconds <= 0)
    return { ok: false, reason: 'malformed' };
  if (
    Math.abs(Math.floor(now.getTime() / 1000) - sentAtSeconds) >
    SIGNATURE_TOLERANCE_SECONDS
  ) {
    return { ok: false, reason: 'stale' };
  }
  if (!verifyDigest(rawBody, timestamp, signatures, secrets))
    return { ok: false, reason: 'bad_signature' };
  return null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function safeMinor(value: unknown, currency: unknown): bigint | undefined {
  if (typeof value !== 'string' || typeof currency !== 'string')
    return undefined;
  try {
    return decimalToMinor(value, currency);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError)
      return undefined;
    throw error;
  }
}

// Refunds, disputes and chargebacks are not modelled yet (ADR-0004); each one is surfaced to
// staff instead of being ignored. The exact Bachs names are matched by family.
const REVERSAL_EVENT =
  /^(refund|dispute|chargeback)\.|^charge\.(refund|dispute)/;

/**
 * Whose event this is (plan Task 5, ADR-0015). A top-level `account` is a connected account's. With
 * none, `organization_id` equal to TipMe's own organization is TipMe's own account (`platform`):
 * a Pro purchase, never a tip. Anything else keeps the old reading: the organization is the
 * connected account (events sent before the partner added `account`).
 */
function scopeOf(
  event: z.infer<typeof eventEnvelopeSchema>,
  platformOrganizationId: string | undefined,
): { platform: boolean; accountReference: string | null } {
  const account = nullableString(event.account);
  if (account) return { platform: false, accountReference: account };
  const organization = nullableString(event.organization_id);
  if (
    organization !== null &&
    platformOrganizationId !== undefined &&
    organization === platformOrganizationId
  )
    return { platform: true, accountReference: null };
  return { platform: false, accountReference: organization };
}

/** The checkout reference initializePayment or initializePlatformCheckout returned for it. */
const checkoutReference = (
  scope: { platform: boolean; accountReference: string | null },
  checkoutId: string,
) =>
  scope.platform
    ? `platform:${checkoutId}`
    : `${scope.accountReference}:${checkoutId}`;

function normalizeEvent(
  event: z.infer<typeof eventEnvelopeSchema>,
  platformOrganizationId: string | undefined,
): NormalizedProviderEvent | undefined {
  // You collect (R1): a dispute on TipMe's own account is modelled; every other stays a reversal.
  if (
    DISPUTE_EVENT_TYPES.has(event.type) &&
    scopeOf(event, platformOrganizationId).platform
  )
    return normalizeDispute(event);
  if (REVERSAL_EVENT.test(event.type))
    return normalizeReversal(event, platformOrganizationId);
  if (!SUPPORTED_EVENT_TYPES.has(event.type))
    return { kind: 'ignored', eventId: event.id, eventType: event.type };

  const data = event.data;
  const currency = stringValue(data['currency']);
  const scope = scopeOf(event, platformOrganizationId);
  const platform = scope.platform;
  const accountReference = scope.accountReference;
  // TipMe's own account updates and payouts are not about any recipient.
  if (
    platform &&
    ![
      'collection.succeeded',
      'collection.failed',
      'collection.underpaid',
      'checkout.completed',
      'payment_method.saved',
    ].includes(event.type)
  )
    return { kind: 'ignored', eventId: event.id, eventType: event.type };
  // A saved card is TipMe's only on its own account; a connected account's is none of ours.
  if (event.type === 'payment_method.saved') {
    if (!platform)
      return { kind: 'ignored', eventId: event.id, eventType: event.type };
    const customer = data['customer'];
    const customerReference =
      typeof customer === 'object' && customer !== null
        ? partnerId((customer as Record<string, unknown>)['customer_id'])
        : null;
    const paymentMethodReference = partnerId(data['payment_method_id']);
    if (!customerReference || !paymentMethodReference) return undefined;
    return {
      kind: 'saved_method',
      eventId: event.id,
      eventType: 'payment_method.saved',
      customerReference,
      paymentMethodReference,
    };
  }
  const scoped = platform ? { scope: 'platform' as const } : {};
  if (
    accountReference !== null &&
    (accountReference.length > 200 ||
      accountReference.includes(':') ||
      /[\u0000-\u001f\u007f]/.test(accountReference))
  ) {
    return undefined;
  }
  if (event.type === 'account.updated' || event.type === 'capability.updated') {
    if (!accountReference) return undefined;
    return {
      kind: 'account',
      eventId: event.id,
      eventType: event.type,
      accountReference,
    };
  }
  // https://docs.bachs.io/guides/webhooks/events/payout-paid.md and payout-failed.md
  if (event.type === 'payout.paid' || event.type === 'payout.failed') {
    const withdrawalId = nullableString(data['withdrawal_id']);
    if (!accountReference || !withdrawalId || withdrawalId.includes(':'))
      return undefined;
    const failureReason = nullableString(data['failure_reason']);
    const stated = nullableString(data['status'])?.toLowerCase();
    const currency = nullableString(data['currency']);
    const amountMinor = eventMoney(data['amount'], currency);
    const feeMinor = eventMoney(data['withdrawal_fee'], currency);
    const reference = nullableString(data['reference']);
    return {
      kind: 'payout',
      eventId: event.id,
      eventType: event.type,
      // The same account-scoped reference initiatePayout returned.
      providerReference: `${accountReference}:${withdrawalId}`,
      accountReference,
      status: event.type === 'payout.paid' ? 'paid' : 'failed',
      ...(event.type === 'payout.failed' && failureReason
        ? { failureReason: payoutFailureReason(failureReason) }
        : {}),
      ...(event.type === 'payout.paid' &&
      ((stated && stated !== 'paid' && stated !== 'completed') ||
        !currency ||
        // The docs always send an amount: one that is missing or unreadable can't be trusted.
        (currency === 'NGN' && amountMinor === undefined))
        ? { contradicted: true as const }
        : {}),
      ...(currency ? { currency } : {}),
      ...(amountMinor === undefined ? {} : { amountMinor }),
      ...(feeMinor === undefined ? {} : { feeMinor }),
      ...(reference ? { operationReference: reference } : {}),
    };
  }
  const checkoutId = nullableString(data['checkout_id']);
  const operationReference = nullableString(data['reference']);
  // TipMe's own account: the payment (charge) the event names. With no checkout, it is an
  // off-session charge (auto-renew), matched as `platform-charge:<id>`.
  const chargeReference = platform
    ? (partnerId(data['charge_id']) ?? partnerId(data['payment_id']))
    : null;
  const charged = platform && !checkoutId && chargeReference !== null;
  const reference = (id: string | null) =>
    id
      ? checkoutReference(scope, id)
      : charged
        ? `platform-charge:${chargeReference}`
        : null;
  const withCharge = platform ? { chargeReference } : {};

  if (event.type === 'collection.succeeded') {
    if (!accountReference && !platform) return undefined;
    // The event is only a trigger (the payment is read back from Bachs), so an amount TipMe
    // cannot parse, such as a crypto collection in USDT_TRC20, is left out rather than refused.
    const amountMinor = currency
      ? safeMinor(data['amount'], currency)
      : undefined;
    const processingFeeCurrency =
      stringValue(data['processing_fee_currency']) ?? currency;
    const feeMinor =
      amountMinor !== undefined && processingFeeCurrency === currency
        ? safeMinor(data['processing_fee'], currency)
        : undefined;
    const hasCheckout = checkoutId !== null || charged;
    return {
      kind: 'payment',
      eventId: event.id,
      eventType: event.type,
      ...scoped,
      ...withCharge,
      providerReference: reference(checkoutId),
      operationReference,
      accountReference,
      // A collection event does not prove who ultimately bore Bachs' processing fee.
      status: hasCheckout ? 'pending' : 'review',
      ...(amountMinor === undefined ? {} : { amountMinor, currency }),
      feeMinor,
      feePaidBy: 'unknown',
    };
  }

  if (event.type === 'collection.failed') {
    if (!accountReference && !platform) return undefined;
    return {
      kind: 'payment',
      eventId: event.id,
      eventType: event.type,
      ...scoped,
      ...withCharge,
      providerReference: reference(checkoutId),
      operationReference,
      accountReference,
      status: checkoutId || charged ? 'failed' : 'review',
      amountMinor: currency ? safeMinor(data['amount'], currency) : undefined,
      currency,
      feePaidBy: 'unknown',
    };
  }

  if (event.type === 'collection.underpaid') {
    if (!currency || (!accountReference && !platform)) return undefined;
    const amountMinor = safeMinor(data['amount_paid'], currency);
    const expectedAmountMinor = safeMinor(data['amount_expected'], currency);
    if (amountMinor === undefined || expectedAmountMinor === undefined)
      return undefined;
    return {
      kind: 'payment',
      eventId: event.id,
      eventType: event.type,
      ...scoped,
      providerReference: checkoutId
        ? checkoutReference(scope, checkoutId)
        : null,
      operationReference,
      accountReference,
      status: 'review',
      amountMinor,
      expectedAmountMinor,
      currency,
      feePaidBy: 'unknown',
    };
  }

  if (event.type === 'checkout.completed') {
    if (!currency || (!accountReference && !platform) || !checkoutId)
      return undefined;
    const amountMinor = safeMinor(data['amount'], currency);
    if (amountMinor === undefined) return undefined;
    return {
      kind: 'payment',
      eventId: event.id,
      eventType: event.type,
      ...scoped,
      providerReference: checkoutReference(scope, checkoutId),
      operationReference,
      accountReference,
      status: data['payment_status'] === 'paid' ? 'pending' : 'unknown',
      amountMinor,
      currency,
      feePaidBy: 'unknown',
    };
  }

  return undefined;
}

/** Ids only: amounts, reasons and customer details stay out of TipMe. */
function normalizeReversal(
  event: z.infer<typeof eventEnvelopeSchema>,
  platformOrganizationId: string | undefined,
): NormalizedProviderEvent | undefined {
  const scope = scopeOf(event, platformOrganizationId);
  const { accountReference } = scope;
  if (
    !scope.platform &&
    (!accountReference ||
      accountReference.length > 200 ||
      accountReference.includes(':') ||
      /[\u0000-\u001f\u007f]/.test(accountReference))
  )
    return undefined;
  const checkoutId = nullableString(event.data['checkout_id']);
  const family = REFUND_EVENT.test(event.type) ? 'refund' : 'dispute';
  // The partner's refund guide: the top-level `id` is the webhook event, the refund is
  // `data.refund_id`. No dispute events are documented, so a dispute is keyed only by an explicit
  // dispute or chargeback id, never a guess.
  const objectId =
    family === 'refund'
      ? partnerId(event.data['refund_id'])
      : (partnerId(event.data['dispute_id']) ??
        partnerId(event.data['chargeback_id']));
  const disputeWon =
    family === 'dispute' &&
    (/\.won$/.test(event.type) || event.data['status'] === 'won');
  const refundState = REFUND_STATES[event.type] ?? null;
  // Bachs collects naira only; an event that names its currency is read in it.
  const currency = stringValue(event.data['currency']) ?? 'NGN';
  const paid = refundState === 'paid';
  return {
    kind: 'reversal',
    eventId: event.id,
    eventType: event.type,
    ...(scope.platform ? { scope: 'platform' as const } : {}),
    accountReference,
    providerReference: checkoutId ? checkoutReference(scope, checkoutId) : null,
    ...(scope.platform
      ? { chargeReference: partnerId(event.data['charge_id']) }
      : {}),
    operationReference: nullableString(event.data['reference']),
    partnerReversalId: objectId ? `${family}.${objectId}` : null,
    disputeWon,
    refundState,
    refundedMinor: paid
      ? (amountOf(event.data['refunded_amount'], currency) ?? null)
      : null,
    refundFeeMinor: paid
      ? (amountOf(event.data['refund_fee_amount'], currency) ?? null)
      : null,
  };
}

/*
 * You collect (plan Task 5, R1). The partner's dispute events, https://docs.bachs.io/connect/disputes
 * and /guides/webhooks/events/dispute-created and dispute-updated: `data.dispute_id`, `charge_id`,
 * `amount` (decimal string) and `currency`, `status`, `reason`, `response_deadline_at`. No fee field
 * is documented. `checkout_id` and `reference` are not documented either; they are read only so the
 * Pro reversal built from this event (disputeAsReversal) is exactly what it was before.
 */
const DISPUTE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'dispute.created',
  'dispute.updated',
]);
/** The docs' statuses (`prevented` appears on events only: stopped early, no money moved). */
const DISPUTE_STATUSES: Readonly<Record<string, DisputeStatus>> = {
  needs_response: 'open',
  under_review: 'responded',
  won: 'won',
  lost: 'lost',
  closed: 'closed',
  prevented: 'closed',
};
/** The partner's reason is a network code; anything else could be free text and is dropped. */
const DISPUTE_REASON = /^[a-z_]{1,40}$/;

/** A partner status in TipMe's words; undefined when it is not one the docs list. */
export function disputeStatusOf(value: unknown): DisputeStatus | undefined {
  return typeof value === 'string' && Object.hasOwn(DISPUTE_STATUSES, value)
    ? DISPUTE_STATUSES[value]
    : undefined;
}

/** A partner timestamp, or undefined when it is not a readable ISO 8601 time. */
function isoTime(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value))
    return undefined;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? undefined : at;
}

/** A disputed amount: a positive decimal string at its ISO currency's precision. */
export function disputeAmount(
  amount: unknown,
  currency: unknown,
): { amountMinor: bigint; currency: string } | undefined {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency))
    return undefined;
  const amountMinor = safeMinor(amount, currency);
  return amountMinor !== undefined && amountMinor > 0n
    ? { amountMinor, currency }
    : undefined;
}

/**
 * TipMe's own dispute. Anything TipMe would act on wrongly (no dispute id, an unreadable amount,
 * status or deadline, no event time) is refused, so the partner delivers it again.
 */
function normalizeDispute(
  event: z.infer<typeof eventEnvelopeSchema>,
): DisputeEvent | undefined {
  const { data } = event;
  const partnerDisputeId = partnerId(data['dispute_id']);
  const status = disputeStatusOf(data['status']);
  const money = disputeAmount(data['amount'], data['currency']);
  const deadline = data['response_deadline_at'];
  const respondBy =
    deadline === null || deadline === undefined ? null : isoTime(deadline);
  const occurredAt = isoTime(event.created_at) ?? isoTime(data['updated_at']);
  if (
    !partnerDisputeId ||
    !status ||
    !money ||
    respondBy === undefined ||
    !occurredAt
  )
    return undefined;
  const reason = data['reason'];
  const checkoutId = nullableString(data['checkout_id']);
  return {
    kind: 'dispute',
    eventId: event.id,
    eventType: event.type as DisputeEvent['eventType'],
    scope: 'platform',
    partnerDisputeId,
    chargeReference: partnerId(data['charge_id']),
    providerReference: checkoutId ? `platform:${checkoutId}` : null,
    operationReference: nullableString(data['reference']),
    status,
    amountMinor: money.amountMinor,
    currency: money.currency,
    reason:
      typeof reason === 'string' && DISPUTE_REASON.test(reason) ? reason : null,
    respondBy,
    feeMinor: null,
    feeCurrency: null,
    occurredAt,
  };
}

/**
 * P5: until Task 9 routes disputes, TipMe's own dispute goes to Pro billing as the reversal the
 * adapter made of it before Task 5, field for field (ids only: no amount, reason or deadline).
 */
export function disputeAsReversal(
  event: DisputeEvent,
): Extract<NormalizedProviderEvent, { kind: 'reversal' }> {
  return {
    kind: 'reversal',
    eventId: event.eventId,
    eventType: event.eventType,
    scope: 'platform',
    accountReference: null,
    providerReference: event.providerReference,
    chargeReference: event.chargeReference,
    operationReference: event.operationReference,
    partnerReversalId: `dispute.${event.partnerDisputeId}`,
    disputeWon: event.status === 'won',
    refundState: null,
    refundedMinor: null,
    refundFeeMinor: null,
  };
}

const REFUND_STATES: Record<string, 'pending' | 'paid' | 'failed'> = {
  'refund.created': 'pending',
  'refund.paid': 'paid',
  'refund.failed': 'failed',
};
/** An amount as a decimal string or a plain number, in minor units; undefined if unreadable. */
const amountOf = (value: unknown, currency: string): bigint | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? safeMinor(String(value), currency)
    : safeMinor(value, currency);

const REFUND_EVENT = /^refund\.|^charge\.refund/;
/** A partner object id we key a reversal on: plain characters only, never free text. */
const partnerId = (value: unknown): string | null =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value)
    ? value
    : null;

export function verifyBachsWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: readonly string[],
  now = new Date(),
  platformOrganizationId?: string,
): WebhookVerification<NormalizedProviderEvent> {
  if (secrets.length === 0) return { ok: false, reason: 'bad_signature' };

  const signatureResult = verifySignature(rawBody, headers, secrets, now);
  if (signatureResult) return signatureResult;

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  const parsed = eventEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, reason: 'malformed' };
  const event = normalizeEvent(parsed.data, platformOrganizationId);
  return event ? { ok: true, event } : { ok: false, reason: 'malformed' };
}

export { SIGNATURE_V2_HEADER };
