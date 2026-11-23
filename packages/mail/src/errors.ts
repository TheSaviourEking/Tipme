/**
 * The provider refused the mail for good: never retry it. `providerFault` marks a refusal about
 * the provider itself (its key, account or sender domain), not this mail: another provider can
 * send it (automatic failover, owner 23 Nov 2026).
 */
export class MailRejectedError extends Error {
  override name = 'MailRejectedError';
  readonly providerFault: boolean;
  constructor(
    readonly code: string,
    options: { providerFault?: boolean } = {},
  ) {
    super(`Mail rejected: ${code}`);
    this.providerFault = options.providerFault ?? false;
  }
}

/**
 * The provider could not take the mail now (network, limits, outage): retry later. `ambiguous`
 * marks an answer that may hide an accepted mail (a success without a message id): sending it
 * through another provider could deliver it twice.
 */
export class MailTemporaryError extends Error {
  override name = 'MailTemporaryError';
  readonly ambiguous: boolean;
  constructor(
    readonly code: string,
    options: { ambiguous?: boolean } = {},
  ) {
    super(`Mail not sent yet: ${code}`);
    this.ambiguous = options.ambiguous ?? false;
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

/**
 * What a failed send means for failover (owner, 23 Nov 2026):
 * - `definite`: the provider certainly did not send it (timeout, 5xx, network, a refused key,
 *   account or sender domain, out of credits). The same mail goes to the next provider at once,
 *   and it counts toward this provider's breaker.
 * - `ambiguous`: it may have been accepted. It is never sent elsewhere, and never counted.
 * - `rejected`: this mail itself was refused (a bad or suppressed address): no other provider
 *   would do better, and it says nothing about the provider.
 */
export function sendFailureOf(error: unknown): {
  kind: 'definite' | 'ambiguous' | 'rejected';
  code: string;
} {
  if (error instanceof MailRejectedError)
    return {
      kind: error.providerFault ? 'definite' : 'rejected',
      code: error.code,
    };
  if (error instanceof MailTemporaryError)
    return {
      kind: error.ambiguous ? 'ambiguous' : 'definite',
      code: error.code,
    };
  return { kind: 'ambiguous', code: 'send_error' };
}
