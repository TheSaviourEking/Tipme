/** Mail providers TipMe can send through. Adding one means one adapter here and nothing else. */
export type MailProviderName = 'mock' | 'zeptomail' | 'ses';

export const MAIL_PROVIDER_NAMES: readonly MailProviderName[] = [
  'mock',
  'zeptomail',
  'ses',
];

/** A rendered email, ready to hand to a provider. Adapters never see template data. */
export interface OutgoingMail {
  /** TipMe's message id; travels with the mail so provider events match it. */
  reference: string;
  to: string;
  from: { address: string; name: string };
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /** Extra headers, e.g. List-Unsubscribe. */
  headers: Record<string, string>;
  /** Opens and clicks are tracked only when true (never for security mail). */
  tracking: boolean;
}

export type MailEventKind =
  | 'delivered'
  | 'opened'
  | 'clicked'
  | 'soft_bounce'
  | 'hard_bounce'
  | 'complaint';

/** One provider event, normalised. Only these fields are ever kept. */
export interface MailProviderEvent {
  kind: MailEventKind;
  providerEventId: string;
  occurredAt: Date;
  address: string | null;
  providerMessageId: string | null;
  reference: string | null;
  /** The `ml` key of a clicked link, never the URL (which may carry a token). */
  linkKey: string | null;
}

export type MailWebhookResult =
  | { ok: true; events: MailProviderEvent[]; confirmSubscriptionUrl?: string }
  | { ok: false; reason: 'signature' | 'stale' | 'malformed' | 'topic' };

export interface MailProviderStatus {
  /** True while the provider only delivers to verified recipients; null when unknown. */
  sandbox: boolean | null;
  detail: string | null;
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export interface MailProvider {
  name: MailProviderName;
  capabilities: { marketing: boolean };
  /** Throws MailRejectedError (never retry) or MailTemporaryError (retry later). */
  send(mail: OutgoingMail): Promise<{ providerMessageId: string }>;
  /** Fetches anything verification needs (SES: the signing certificate) before verifyWebhook. */
  prepareWebhook?(rawBody: Buffer): Promise<void>;
  verifyWebhook(
    rawBody: Buffer,
    headers: WebhookHeaders,
    now: Date,
  ): MailWebhookResult;
  status(): Promise<MailProviderStatus>;
}
