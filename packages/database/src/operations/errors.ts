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
  | 'HANDLE_CHANGE_PRO_REQUIRED'
  | 'HANDLE_CHANGE_LIMIT'
  | 'PRO_REQUIRED'
  | 'QR_DESIGN_PRO_REQUIRED'
  | 'INVALID_TIP_PRESETS'
  | 'INVALID_TIP_MINIMUM'
  | 'WITHDRAWAL_TOO_SMALL'
  | 'WITHDRAWAL_UNAVAILABLE'
  | 'WITHDRAWALS_PAUSED'
  | 'WITHDRAWALS_SWITCHED_OFF'
  | 'PAYOUT_SETUP_NEEDED'
  | 'PAYOUT_DESTINATION_NEEDED'
  | 'PAYOUT_DESTINATION_REFUSED'
  | 'BANK_CHANGE_HELD'
  | 'PAYOUT_PROVIDER_UNAVAILABLE'
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
  | 'ISSUE_OUTCOME_REQUIRED'
  | 'ISSUE_PAYOUT_UNFINISHED'
  | 'MARKET_ENTRY_NOT_FOUND'
  | 'PERMISSION_NOT_HELD'
  | 'FRESH_CODE_REQUIRED'
  | 'STAFF_ADMIN_BUSY'
  | 'ISSUE_OWN_ALERT'
  | 'APPROVAL_NOT_FOUND'
  | 'APPROVAL_OWN_REQUEST'
  | 'APPROVAL_NOT_YOURS'
  | 'APPROVAL_SUBJECT'
  | 'APPROVAL_CLOSED'
  | 'APPROVAL_EXPIRED'
  | 'APPROVAL_ALREADY_PENDING'
  | 'RECOVERY_STAFF_ACCOUNT'
  | 'PAYOUT_CHANGED'
  | 'NO_CONFIRMED_TEST'
  | 'PROVIDER_NOT_ALLOWED'
  | 'PROVIDER_STATUS_UNKNOWN'
  | 'SELF_ACCESS_CHANGE'
  | 'ROLE_NOT_FOUND'
  | 'ROLE_NAME_TAKEN'
  | 'ROLE_IN_USE'
  | 'ROLE_PROTECTED'
  | 'STAFF_NOT_FOUND'
  | 'STAFF_PROTECTED'
  | 'STAFF_CHANGED'
  | 'LAST_OWNER'
  | 'ROLE_HAS_FORMER_HOLDERS'
  | 'STAFF_EMAIL_TAKEN'
  | 'STAFF_NO_EMAIL'
  | 'STAFF_EMAIL_LOCKED'
  | 'STAFF_PHONE_LOCKED'
  | 'STAFF_CANNOT_DELETE'
  | 'STAFF_ALREADY_ENROLLED';

/**
 * Expected business outcomes callers map to responses; never carries request values. `detail` is
 * for a server operator's console (masked data only) and never reaches an API response.
 */
export class OperationError extends Error {
  override readonly name = 'OperationError';
  constructor(
    readonly code: OperationErrorCode,
    readonly detail?: string,
  ) {
    super(code);
  }
}

/**
 * Any unexpected database failure. Carries only the SQLSTATE: driver and ORM errors embed the
 * failed query's parameters (which can include payer messages), so they never travel upward.
 */
export class PersistenceError extends Error {
  override readonly name = 'PersistenceError';
  constructor(
    readonly sqlState: string | undefined,
    /** Why, in fixed words: never the driver's message, which can quote values. */
    readonly failure?: DatabaseFailure,
  ) {
    super(
      `Database operation failed${
        sqlState
          ? ` (SQLSTATE ${sqlState})`
          : failure
            ? ` (${failure.kind}${failure.errno ? ` ${failure.errno}` : ''})`
            : ''
      }`,
    );
  }
}

/**
 * What stopped a database call, safe to log and report. `pool_wait_timeout` is this process's own
 * pool being busy; `connect_timeout` is a slow or unreachable server; SQLSTATE 53300 is the server
 * refusing because it is full. They need different fixes, so a 503 must say which it was.
 */
export interface DatabaseFailure {
  kind:
    | 'sqlstate'
    | 'pool_wait_timeout'
    | 'connect_timeout'
    | 'connection_lost'
    | 'network'
    | 'unknown';
  sqlState?: string;
  errno?: string;
  /** The original error's class name, for `unknown`. */
  causeName?: string;
}

// pg and pg-pool throw these fixed strings without a code (checked against the installed versions).
const driverFailures: [RegExp, DatabaseFailure['kind']][] = [
  [/^timeout exceeded when trying to connect$/, 'pool_wait_timeout'],
  [/^Connection terminated due to connection timeout$/, 'connect_timeout'],
  [/^timeout expired$/, 'connect_timeout'],
  [/^Connection terminated/, 'connection_lost'],
];

/** Finds a recognised database failure on an error or its causes; null if there is none. */
export function databaseFailureOf(error: unknown): DatabaseFailure | null {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof PersistenceError) {
      if (current.failure) return current.failure;
      if (current.sqlState)
        return { kind: 'sqlstate', sqlState: current.sqlState };
    }
    const { code, message, cause } = current as {
      code?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (typeof code === 'string') {
      if (isSqlState(code)) return { kind: 'sqlstate', sqlState: code };
      if (/^E[A-Z]+$/.test(code)) return { kind: 'network', errno: code };
    }
    if (typeof message === 'string')
      for (const [pattern, kind] of driverFailures)
        if (pattern.test(message)) return { kind };
    current = cause;
  }
  return null;
}

/** The database could not serve right now, and the same call can succeed later. */
export function isDatabaseAvailabilityFailure(error: unknown): boolean {
  const failure = databaseFailureOf(error);
  if (!failure || failure.kind === 'unknown') return false;
  return failure.kind !== 'sqlstate' || isTransientSqlState(failure.sqlState);
}

export function isTransientSqlState(state: string | undefined): boolean {
  return (
    state !== undefined &&
    (/^(08|53|57P)/.test(state) || state === '40001' || state === '40P01')
  );
}

// Five capitals could also be an errno (EPIPE), which is not a SQLSTATE.
const isSqlState = (code: string) =>
  /^[0-9A-Z]{5}$/.test(code) && !/^E[A-Z]{4}$/.test(code);

export function sqlStateOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && isSqlState(code)) return code;
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
    throw new PersistenceError(
      sqlStateOf(error),
      databaseFailureOf(error) ?? {
        kind: 'unknown',
        causeName: error instanceof Error ? error.name : typeof error,
      },
    );
  }
}

/** The name and allowlisted diagnostic only: an error's message may name an account. */
export function safeError(error: unknown): {
  error: string;
  cause?: string;
  http_status?: number;
  provider_code?: string;
} {
  const diagnostic =
    error instanceof Error && 'diagnostic' in error
      ? (error.diagnostic as
          | { cause?: string; httpStatus?: number; providerCode?: string }
          | undefined)
      : undefined;
  return {
    error: error instanceof Error ? error.name : 'unknown',
    ...(diagnostic?.cause ? { cause: diagnostic.cause } : {}),
    ...(diagnostic?.httpStatus ? { http_status: diagnostic.httpStatus } : {}),
    ...(diagnostic?.providerCode
      ? { provider_code: diagnostic.providerCode }
      : {}),
  };
}
