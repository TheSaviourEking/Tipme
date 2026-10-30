export const apiErrorCodes = [
  'VALIDATION_FAILED',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'IDEMPOTENCY_CONFLICT',
  'QUOTE_EXPIRED',
  'QUOTE_ALREADY_USED',
  'TIP_NOT_PAYABLE',
  'UNAUTHENTICATED',
  'FORBIDDEN_ORIGIN',
  'CODE_INVALID',
  'SIGN_IN_LOCKED',
  'HANDLE_TAKEN',
  'HANDLE_RENAME_LIMIT',
  'ALREADY_HAS_PAGE',
  'HAS_BALANCE',
  'INSUFFICIENT_BALANCE',
  'WITHDRAWAL_TOO_SMALL',
  'WITHDRAWAL_UNAVAILABLE',
  'PRO_REQUIRED',
  'INVALID_IMAGE',
  'PHONE_TAKEN',
  'RECOVERY_PENDING',
  'FORBIDDEN',
  'ENROLMENT_INVALID',
  'OPS_LOCKED',
  'PAGE_SUSPENDED',
  'ISSUE_RESOLVED',
  'PREVIEW_REQUIRED',
  'PROFILE_NOT_FOUND',
  'RATE_LIMITED',
  'DEPENDENCY_UNAVAILABLE',
  'EMAIL_VERIFICATION_REQUIRED',
  'PAYMENT_ACCOUNT_REQUIRED',
  'PROVIDER_OUTCOME_UNKNOWN',
  'PAYMENT_START_REJECTED',
  'NO_CONFIRMED_TEST',
  'EMAIL_TAKEN',
  'SAME_AS_SIGN_IN_EMAIL',
  'SIGN_IN_CODE_REQUIRED',
  'PROVIDER_NOT_ALLOWED',
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof apiErrorCodes)[number];

/** `reference` is the trace ID support uses to find the request; `fields` holds paths only, never values. */
export interface ApiErrorResponse {
  error: {
    code: ApiErrorCode;
    message: string;
    reference: string;
    fields?: string[];
  };
}

/** PRD response convention for versioned (/v1) routes: `{ data, meta? }` on success, `{ error }` on failure. */
export interface ApiDataResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}
