import { isTransientSqlState } from '@tipme/database';

/**
 * Whether a database failure is about availability (the provider should retry: 503) rather than
 * a deterministic problem with this message (retrying would never help: 500). No SQLSTATE means
 * the database could not be reached at all.
 */
export function isRetryablePersistenceError(error: {
  name: string;
  sqlState?: string;
}): boolean {
  if (error.name !== 'PersistenceError') return false;
  return error.sqlState === undefined || isTransientSqlState(error.sqlState);
}

/**
 * An account event that may be about an account still being set up: the partner sends it during
 * the create call, before TipMe has saved the account's reference. Answered 503 so the partner
 * delivers it again once the reference is saved (see WebhookService.refreshBachsAccount).
 */
export class AccountSetupInFlightError extends Error {
  override readonly name = 'AccountSetupInFlightError';
  constructor() {
    super('an account setup is in flight; deliver the event again later');
  }
}
