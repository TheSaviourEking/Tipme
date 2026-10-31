import { createPublicKey, verify } from 'node:crypto';

const STALE_AFTER_MS = 60 * 60_000;

export interface SnsEnvelope {
  Type: string;
  MessageId: string;
  TopicArn: string;
  Timestamp: string;
  Message: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
}

const NOTIFICATION_FIELDS = [
  'Message',
  'MessageId',
  'Subject',
  'Timestamp',
  'TopicArn',
  'Type',
] as const;
const SUBSCRIPTION_FIELDS = [
  'Message',
  'MessageId',
  'SubscribeURL',
  'Timestamp',
  'Token',
  'TopicArn',
  'Type',
] as const;

/** SNS hosts its signing certificates (and subscribe links) only on this host, over HTTPS. */
export function isSnsUrl(value: string | undefined, region: string): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === `sns.${region}.amazonaws.com`
    );
  } catch {
    return false;
  }
}

/** AWS's signing certificates, and nothing else on that host: no query, port or other path. */
export function isSnsCertUrl(value: string, region: string): boolean {
  if (!isSnsUrl(value, region)) return false;
  const url = new URL(value);
  return (
    !url.search &&
    !url.hash &&
    !url.port &&
    !url.username &&
    !url.password &&
    /^\/SimpleNotificationService-[0-9a-f]+\.pem$/.test(url.pathname)
  );
}

export function parseEnvelope(rawBody: Buffer): SnsEnvelope | null {
  try {
    const value: unknown = JSON.parse(rawBody.toString('utf8'));
    if (!value || typeof value !== 'object') return null;
    const e = value as Record<string, unknown>;
    for (const key of [
      'Type',
      'MessageId',
      'TopicArn',
      'Timestamp',
      'Message',
      'SignatureVersion',
      'Signature',
      'SigningCertURL',
    ])
      if (typeof e[key] !== 'string') return null;
    return e as unknown as SnsEnvelope;
  } catch {
    return null;
  }
}

/** The string SNS signs: each present field as "Name\nvalue\n", in AWS's fixed order. */
function canonical(envelope: SnsEnvelope): string | null {
  const fields =
    envelope.Type === 'Notification'
      ? NOTIFICATION_FIELDS
      : envelope.Type === 'SubscriptionConfirmation' ||
          envelope.Type === 'UnsubscribeConfirmation'
        ? SUBSCRIPTION_FIELDS
        : null;
  if (!fields) return null;
  return fields
    .filter((key) => envelope[key] !== undefined)
    .map((key) => `${key}\n${envelope[key]}\n`)
    .join('');
}

export type SnsCheck = 'ok' | 'signature' | 'stale' | 'topic';

export function checkEnvelope(
  envelope: SnsEnvelope,
  certPem: string | undefined,
  topicArn: string,
  now: Date,
): SnsCheck {
  if (envelope.TopicArn !== topicArn) return 'topic';
  const text = canonical(envelope);
  if (!text || !certPem) return 'signature';
  const algorithm =
    envelope.SignatureVersion === '1'
      ? 'sha1'
      : envelope.SignatureVersion === '2'
        ? 'sha256'
        : null;
  if (!algorithm) return 'signature';
  let valid = false;
  try {
    valid = verify(
      algorithm,
      Buffer.from(text, 'utf8'),
      createPublicKey(certPem),
      Buffer.from(envelope.Signature, 'base64'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return 'signature';
  const sent = Date.parse(envelope.Timestamp);
  if (Number.isNaN(sent) || Math.abs(now.getTime() - sent) > STALE_AFTER_MS)
    return 'stale';
  return 'ok';
}
