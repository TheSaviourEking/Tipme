import {
  GetAccountCommand,
  SendEmailCommand,
  SESv2Client,
} from '@aws-sdk/client-sesv2';
import { MailRejectedError, MailTemporaryError } from '../errors.js';
import type { MailProvider } from '../provider.js';
import { sesEvents } from './events.js';
import { checkEnvelope, isSnsCertUrl, isSnsUrl, parseEnvelope } from './sns.js';

export interface SesConfig {
  region: string;
  /** Omitted: the SDK's default chain (e.g. the machine's role). */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Opens and clicks tracked (all but security mail). */
  configurationSet: string;
  /** No open or click tracking (security mail). */
  configurationSetUntracked: string;
  /** The SNS topic SES publishes events to; anything else is refused. */
  topicArn: string;
  client?: Pick<SESv2Client, 'send'>;
  fetchCert?: (url: string) => Promise<string>;
}

const MAX_CERTS = 16;
const MAX_CERT_CHARS = 16 * 1024;

const PERMANENT = new Set([
  'MessageRejected',
  'MailFromDomainNotVerifiedException',
  'AccountSuspendedException',
  'BadRequestException',
  'NotFoundException',
]);

function sesError(error: unknown): MailRejectedError | MailTemporaryError {
  const name = error instanceof Error ? error.name : 'unknown';
  if (name === 'TimeoutError') return new MailTemporaryError('timeout');
  if (PERMANENT.has(name)) return new MailRejectedError(name);
  return new MailTemporaryError(name);
}

const quoted = (name: string) => `"${name.replace(/["\\]/g, '')}"`;

/** Amazon SES (SESv2) in the project's region; events arrive through SNS. */
export function createSesProvider(config: SesConfig): MailProvider {
  const client =
    config.client ??
    new SESv2Client({
      region: config.region,
      ...(config.credentials ? { credentials: config.credentials } : {}),
    });
  const fetchCert =
    config.fetchCert ??
    (async (url: string) => {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(5000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`certificate ${response.status}`);
      const pem = await response.text();
      if (pem.length > MAX_CERT_CHARS) throw new Error('certificate too large');
      return pem;
    });
  const certs = new Map<string, string>();

  return {
    name: 'ses',
    capabilities: { marketing: true },
    async send(mail) {
      try {
        const result = await client.send(
          new SendEmailCommand({
            FromEmailAddress: `${quoted(mail.from.name)} <${mail.from.address}>`,
            Destination: { ToAddresses: [mail.to] },
            ...(mail.replyTo ? { ReplyToAddresses: [mail.replyTo] } : {}),
            Content: {
              Simple: {
                Subject: { Data: mail.subject, Charset: 'UTF-8' },
                Body: {
                  Text: { Data: mail.text, Charset: 'UTF-8' },
                  Html: { Data: mail.html, Charset: 'UTF-8' },
                },
                Headers: Object.entries(mail.headers).map(([Name, Value]) => ({
                  Name,
                  Value,
                })),
              },
            },
            ConfigurationSetName: mail.tracking
              ? config.configurationSet
              : config.configurationSetUntracked,
            EmailTags: [{ Name: 'ref', Value: mail.reference }],
          }),
        );
        if (!result.MessageId) throw new MailTemporaryError('no_message_id');
        return { providerMessageId: result.MessageId };
      } catch (error) {
        if (error instanceof MailTemporaryError) throw error;
        throw sesError(error);
      }
    },
    async prepareWebhook(rawBody) {
      const envelope = parseEnvelope(rawBody);
      if (!envelope || !isSnsCertUrl(envelope.SigningCertURL, config.region))
        return;
      if (certs.has(envelope.SigningCertURL)) return;
      const pem = await fetchCert(envelope.SigningCertURL);
      // AWS rotates these rarely; a small bound keeps the unauthenticated route from growing it.
      if (certs.size >= MAX_CERTS) certs.clear();
      certs.set(envelope.SigningCertURL, pem);
    },
    verifyWebhook(rawBody, _headers, now) {
      const envelope = parseEnvelope(rawBody);
      if (!envelope) return { ok: false, reason: 'malformed' };
      if (!isSnsCertUrl(envelope.SigningCertURL, config.region))
        return { ok: false, reason: 'signature' };
      const check = checkEnvelope(
        envelope,
        certs.get(envelope.SigningCertURL),
        config.topicArn,
        now,
      );
      if (check !== 'ok') return { ok: false, reason: check };
      if (envelope.Type === 'SubscriptionConfirmation') {
        if (!isSnsUrl(envelope.SubscribeURL, config.region))
          return { ok: false, reason: 'malformed' };
        return {
          ok: true,
          events: [],
          confirmSubscriptionUrl: envelope.SubscribeURL!,
        };
      }
      if (envelope.Type !== 'Notification') return { ok: true, events: [] };
      const events = sesEvents(envelope.Message, envelope.MessageId, now);
      return events ? { ok: true, events } : { ok: false, reason: 'malformed' };
    },
    async status() {
      const account = await client.send(new GetAccountCommand({}));
      const quota = account.SendQuota?.Max24HourSend;
      return {
        sandbox: account.ProductionAccessEnabled !== true,
        detail: quota === undefined ? null : `${quota} emails a day`,
      };
    },
  };
}
