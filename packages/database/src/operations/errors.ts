export type OperationErrorCode =
  | 'PROFILE_NOT_FOUND'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'QUOTE_NOT_FOUND'
  | 'QUOTE_EXPIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'TIP_NOT_PAYABLE'
  | 'CURRENCY_MISMATCH'
  | 'PAYOUT_NOT_FOUND'
  | 'ATTEMPT_NOT_FOUND'
  | 'INVALID_INPUT'
  | 'QUOTE_ALREADY_USED'
  | 'HANDLE_TAKEN'
  | 'HANDLE_RENAME_LIMIT'
  | 'PRO_REQUIRED'
  | 'INVALID_TIP_PRESETS'
  | 'INVALID_TIP_MINIMUM'
  | 'WITHDRAWAL_TOO_SMALL'
  | 'ALREADY_HAS_PAGE'
  | 'HAS_BALANCE'
  | 'NO_PAGE'
  | 'INSUFFICIENT_BALANCE'
  | 'CODE_INVALID'
  | 'PHONE_TAKEN'
  | 'ENROLMENT_INVALID'
  | 'PAGE_SUSPENDED'
  | 'EMAIL_VERIFICATION_REQUIRED'
  | 'ISSUE_NOT_FOUND'
  | 'ISSUE_RESOLVED'
  | 'MARKET_ENTRY_NOT_FOUND';

/** Expected business outcomes callers map to responses; never carries request values. */
export class OperationError extends Error {
  override readonly name = 'OperationError';
  constructor(readonly code: OperationErrorCode) {
    super(code);
  }
}

/**
 * Any unexpected database failure. Carries only the SQLSTATE: driver and ORM errors embed the
 * failed query's parameters (which can include payer messages), so they never travel upward.
 */
export class PersistenceError extends Error {
  override readonly name = 'PersistenceError';
  constructor(readonly sqlState: string | undefined) {
    super(
      `Database operation failed${sqlState ? ` (SQLSTATE ${sqlState})` : ''}`,
    );
  }
}

export function sqlStateOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** Runs an operation, replacing unexpected errors with a value-free PersistenceError. */
export async function guarded<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OperationError) throw error;
    throw new PersistenceError(sqlStateOf(error));
  }
}
