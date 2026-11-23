import { timingSafeEqual } from 'node:crypto';
import {
  MailQuotaError,
  MailRejectedError,
  MailTemporaryError,
} from '../errors.js';
import type {
  MailEventKind,
  MailProvider,
  MailProviderEvent,
  MailWebhookResult,
  WebhookHeaders,
} from '../provider.js';

/*
 * Brevo, for announcements (owner, 14 Nov 2026) and, when staff switch to it by hand, codes,
 * receipts and alerts (owner, 23 Nov 2026): two instances, both through the transactional send API
 * below, never a contact list or a campaign. Its help centre lists the email API as a way
 * to send marketing mail, unlike ZeptoMail, so `capabilities.marketing` is true. Documented API
 * (read 14 Nov 2026): POST {base}/v3/smtp/email with an `api-key` header; 201 { messageId };
 * 429 when rate limited. Sandbox mode is the `X-Sib-Sandbox: drop` header: the request is checked
 * and nothing is sent. Webhooks are not signed; they carry a bearer token set when the webhook is
 * created, which is compared here in constant time.
 */
export interface BrevoConfig {
  apiKey: string;
  /** No path, e.g. https://api.brevo.com. */
  apiBase: string;
  /**
   * Set (announcements): the verified sender every mail comes from, e.g. news@usetipme.xyz, with
   * the type's name. Unset (codes, receipts and alerts): each mail's own sender, as with ZeptoMail.
   */
  fromAddress?: string | undefined;
  /** The bearer token Brevo's webhook sends; without it every webhook is refused. */
  webhookToken?: string | undefined;
  /** Brevo checks each request and sends nothing (staging and tests). */
  sandbox: boolean;
  /**
   * The codes instance: its status warns staff that Brevo may still rewrite links. Brevo has no
   * per-email switch for click tracking (its send reference, read 23 Nov 2026), only an account
   * setting, so security mail is safe only once that is off for the account.
   */
  linkTrackingWarning?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const REFERENCE = 'tipme_ref:';

/*
 * Out of credits. Brevo's reference for POST /v3/smtp/email (read 15 Nov 2026) lists only 201, 202
 * and 400; its 400 `code` list holds both `not_enough_credits` and `Insufficient credits`. Matched
 * case-insensitively, on the code or the message, and on 402 (Payment Required) in case Brevo ever
 * answers that way. It is a pause until credits come back, never a refusal.
 */
const CREDIT_WORDS = [
  'not_enough_credits',
  'insufficient credits',
  'not enough credits',
];

/** Brevo error codes about the account, not the mail (documented error codes). */
const BREVO_ACCOUNT_CODES = new Set([
  'unauthorized',
  'permission_denied',
  'account_under_validation',
]);

function outOfCredits(
  status: number,
  body: { code?: unknown; message?: unknown } | null,
): boolean {
  if (status === 402) return true;
  return [body?.code, body?.message].some(
    (value) =>
      typeof value === 'string' &&
      CREDIT_WORDS.some((words) => value.toLowerCase().includes(words)),
  );
}

const KINDS: Record<string, MailEventKind> = {
  delivered: 'delivered',
  hard_bounce: 'hard_bounce',
  soft_bounce: 'soft_bounce',
  spam: 'complaint',
  opened: 'opened',
  unique_opened: 'opened',
  click: 'clicked',
};

const sameText = (a: string, b: string) => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

const headerOf = (headers: WebhookHeaders, name: string) => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
};

function linkKeyOf(link: unknown): string | null {
  if (typeof link !== 'string') return null;
  try {
    return new URL(link).searchParams.get('ml');
  } catch {
    return null;
  }
}

function eventOf(raw: unknown): MailProviderEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  const kind = typeof e['event'] === 'string' ? KINDS[e['event']] : undefined;
  if (!kind) return null;
  const messageId =
    typeof e['message-id'] === 'string' ? e['message-id'] : null;
  const seconds = typeof e['ts_event'] === 'number' ? e['ts_event'] : null;
  const custom =
    typeof e['X-Mailin-custom'] === 'string' ? e['X-Mailin-custom'] : '';
  return {
    kind,
    providerEventId: `${messageId ?? e['id'] ?? 'unknown'}:${String(e['event'])}:${seconds ?? ''}`,
    occurredAt: seconds === null ? new Date() : new Date(seconds * 1000),
    address: typeof e['email'] === 'string' ? e['email'] : null,
    providerMessageId: messageId,
    reference: custom.startsWith(REFERENCE)
      ? custom.slice(REFERENCE.length)
      : null,
    linkKey: kind === 'clicked' ? linkKeyOf(e['link']) : null,
  };
}

export function createBrevoProvider(config: BrevoConfig): MailProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${config.apiBase.replace(/\/+$/, '')}/v3/smtp/email`;
  return {
    name: 'brevo',
    capabilities: { marketing: true },
    async send(mail) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'api-key': config.apiKey,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            // Brevo sends only from a verified sender or domain: the announcement address when
            // fixed, else the type's own address on the authenticated mail domain.
            sender: {
              email: config.fromAddress ?? mail.from.address,
              name: mail.from.name,
            },
            // Untracked mail (security mail: never a pixel next to a code): no open pixel and no
            // per-contact tracking. Brevo honours these only on plans that support them, and
            // neither stops link rewriting (linkTrackingWarning).
            to: [
              mail.tracking
                ? { email: mail.to }
                : {
                    email: mail.to,
                    removeTrackingPixel: true,
                    contactPixelTrackingConsent: false,
                  },
            ],
            ...(mail.replyTo ? { replyTo: { email: mail.replyTo } } : {}),
            subject: mail.subject,
            htmlContent: mail.html,
            textContent: mail.text,
            headers: {
              ...mail.headers,
              // Comes back on every webhook event, so events find their message.
              'X-Mailin-custom': `${REFERENCE}${mail.reference}`,
              ...(config.sandbox ? { 'X-Sib-Sandbox': 'drop' } : {}),
            },
          }),
          signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
        });
      } catch (error) {
        throw new MailTemporaryError(
          error instanceof Error && error.name === 'TimeoutError'
            ? 'timeout'
            : 'network',
        );
      }
      const body = (await response.json().catch(() => null)) as {
        messageId?: unknown;
        code?: unknown;
        message?: unknown;
      } | null;
      if (!response.ok) {
        if (outOfCredits(response.status, body))
          throw new MailQuotaError('not_enough_credits');
        if (response.status === 429 || response.status >= 500)
          throw new MailTemporaryError(`http_${response.status}`);
        const code =
          typeof body?.code === 'string'
            ? body.code.slice(0, 60)
            : `http_${response.status}`;
        // The key, its permissions or the account were refused: about Brevo, not this mail.
        throw new MailRejectedError(code, {
          providerFault:
            response.status === 401 ||
            response.status === 403 ||
            BREVO_ACCOUNT_CODES.has(code),
        });
      }
      // Accepted, perhaps: another provider could deliver it twice.
      if (typeof body?.messageId !== 'string')
        throw new MailTemporaryError('no_message_id', { ambiguous: true });
      return { providerMessageId: body.messageId };
    },
    verifyWebhook(rawBody, headers): MailWebhookResult {
      const auth = headerOf(headers, 'authorization') ?? '';
      if (
        !config.webhookToken ||
        !sameText(auth, `Bearer ${config.webhookToken}`)
      )
        return { ok: false, reason: 'signature' };
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody.toString('utf8'));
      } catch {
        return { ok: false, reason: 'malformed' };
      }
      const raw = Array.isArray(parsed) ? parsed : [parsed];
      return {
        ok: true,
        events: raw
          .map(eventOf)
          .filter((event): event is MailProviderEvent => event !== null),
      };
    },
    async status() {
      return {
        sandbox: config.sandbox,
        detail: config.sandbox
          ? 'Sandbox: Brevo checks and drops'
          : config.linkTrackingWarning
            ? 'Brevo may still rewrite links in security emails unless click tracking is off for this Brevo account'
            : null,
      };
    },
  };
}
