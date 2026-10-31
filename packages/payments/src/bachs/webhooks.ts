import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type {
  NormalizedProviderEvent,
  WebhookVerification,
} from '../provider.js';
import { decimalToMinor } from './money.js';

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
]);

const eventEnvelopeSchema = z.object({
  id: z.string().min(1).max(200),
  type: z.string().min(1).max(200),
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

function normalizeEvent(
  event: z.infer<typeof eventEnvelopeSchema>,
): NormalizedProviderEvent | undefined {
  if (REVERSAL_EVENT.test(event.type)) return normalizeReversal(event);
  if (!SUPPORTED_EVENT_TYPES.has(event.type))
    return { kind: 'ignored', eventId: event.id, eventType: event.type };

  const data = event.data;
  const currency = stringValue(data['currency']);
  const accountReference =
    nullableString(event.account) ?? nullableString(event.organization_id);
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
  const checkoutId = nullableString(data['checkout_id']);
  const operationReference = nullableString(data['reference']);

  if (event.type === 'collection.succeeded') {
    if (!accountReference) return undefined;
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
    const hasCheckout = checkoutId !== null;
    return {
      kind: 'payment',
      eventId: event.id,
      eventType: event.type,
      providerReference: hasCheckout
        ? `${accountReference}:${checkoutId}`
        : null,
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
    if (!accountReference) return undefined;
    return {
      kind: 'payment',
      eventId: event.id,
      eventType: event.type,
      providerReference: checkoutId
        ? `${accountReference}:${checkoutId}`
        : null,
      operationReference,
      accountReference,
      status: checkoutId ? 'failed' : 'review',
      amountMinor: currency ? safeMinor(data['amount'], currency) : undefined,
      currency,
      feePaidBy: 'unknown',
    };
  }

  if (event.type === 'collection.underpaid') {
    if (!currency || !accountReference) return undefined;
    const amountMinor = safeMinor(data['amount_paid'], currency);
    const expectedAmountMinor = safeMinor(data['amount_expected'], currency);
    if (amountMinor === undefined || expectedAmountMinor === undefined)
      return undefined;
    return {
      kind: 'payment',
      eventId: event.id,
      eventType: event.type,
      providerReference: checkoutId
        ? `${accountReference}:${checkoutId}`
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
    if (!currency || !accountReference || !checkoutId) return undefined;
    const amountMinor = safeMinor(data['amount'], currency);
    if (amountMinor === undefined) return undefined;
    return {
      kind: 'payment',
      eventId: event.id,
      eventType: event.type,
      providerReference: `${accountReference}:${checkoutId}`,
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
): NormalizedProviderEvent | undefined {
  const accountReference =
    nullableString(event.account) ?? nullableString(event.organization_id);
  if (
    !accountReference ||
    accountReference.length > 200 ||
    accountReference.includes(':') ||
    /[\u0000-\u001f\u007f]/.test(accountReference)
  )
    return undefined;
  const checkoutId = nullableString(event.data['checkout_id']);
  return {
    kind: 'reversal',
    eventId: event.id,
    eventType: event.type,
    accountReference,
    providerReference: checkoutId ? `${accountReference}:${checkoutId}` : null,
    operationReference: nullableString(event.data['reference']),
  };
}

export function verifyBachsWebhook(
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
  secrets: readonly string[],
  now = new Date(),
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
  const event = normalizeEvent(parsed.data);
  return event ? { ok: true, event } : { ok: false, reason: 'malformed' };
}

export { SIGNATURE_V2_HEADER };
