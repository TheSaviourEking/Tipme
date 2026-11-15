/** The provider refused the mail for good (bad address, unverified sender): never retry it. */
export class MailRejectedError extends Error {
  override name = 'MailRejectedError';
  constructor(readonly code: string) {
    super(`Mail rejected: ${code}`);
  }
}

/** The provider could not take the mail now (network, limits, outage): retry later. */
export class MailTemporaryError extends Error {
  override name = 'MailTemporaryError';
  constructor(readonly code: string) {
    super(`Mail not sent yet: ${code}`);
  }
}

/**
 * The provider's sending allowance is used up (Brevo's free plan: 300 a day). A temporary error the
 * outbox treats as a pause: the mail waits for the allowance to come back and never uses up its
 * attempts on it, so nothing fails for running out of credits.
 */
export class MailQuotaError extends MailTemporaryError {
  override name = 'MailQuotaError';
}
