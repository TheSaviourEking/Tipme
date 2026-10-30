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
