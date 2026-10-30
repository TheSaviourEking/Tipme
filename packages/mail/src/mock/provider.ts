import type { MailProvider, OutgoingMail } from '../provider.js';

/**
 * The pretend provider (development and tests only; refused in production). It accepts every
 * mail and hands it to `sink`, which the worker points at the pretend inbox.
 */
export function createMockMailProvider(
  sink: (mail: OutgoingMail) => Promise<void>,
): MailProvider {
  return {
    name: 'mock',
    capabilities: { marketing: true },
    async send(mail) {
      await sink(mail);
      return { providerMessageId: `mock-${mail.reference}` };
    },
    verifyWebhook() {
      return { ok: false, reason: 'signature' };
    },
    async status() {
      return { sandbox: null, detail: 'pretend' };
    },
  };
}
