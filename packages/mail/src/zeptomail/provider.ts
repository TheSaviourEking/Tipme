import { MailTemporaryError } from '../errors.js';
import type { MailProvider } from '../provider.js';
import { zeptoError } from './errors.js';
import { verifyZeptoWebhook } from './webhook.js';

export interface ZeptoMailConfig {
  apiKey: string;
  /** The account's data-centre API base, e.g. https://api.zeptomail.com (no path). */
  apiBase: string;
  /** The Agent's webhook authentication key (signs every webhook). */
  webhookKey: string;
  bounceAddress?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** ZeptoMail (Zoho): transactional only, so `capabilities.marketing` is false. */
export function createZeptoMailProvider(config: ZeptoMailConfig): MailProvider {
  const fetchImpl = config.fetchImpl ?? fetch;
  const endpoint = `${config.apiBase.replace(/\/+$/, '')}/v1.1/email`;
  return {
    name: 'zeptomail',
    capabilities: { marketing: false },
    async send(mail) {
      let response: Response;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            Authorization: `Zoho-enczapikey ${config.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            from: mail.from,
            to: [{ email_address: { address: mail.to } }],
            ...(mail.replyTo ? { reply_to: [{ address: mail.replyTo }] } : {}),
            subject: mail.subject,
            textbody: mail.text,
            htmlbody: mail.html,
            client_reference: mail.reference,
            mime_headers: mail.headers,
            track_opens: mail.tracking,
            track_clicks: mail.tracking,
            ...(config.bounceAddress
              ? { bounce_address: config.bounceAddress }
              : {}),
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
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) throw zeptoError(response.status, body);
      const id =
        body && typeof body === 'object'
          ? (body as { request_id?: unknown }).request_id
          : undefined;
      if (typeof id !== 'string' || !id)
        throw new MailTemporaryError('no_request_id');
      return { providerMessageId: id };
    },
    verifyWebhook: (rawBody, headers, now) =>
      verifyZeptoWebhook(rawBody, headers, config.webhookKey, now),
    async status() {
      // ZeptoMail has no account-status API: a confirmed test is the evidence.
      return { sandbox: null, detail: null };
    },
  };
}
