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
  'ALREADY_HAS_PAGE',
  'HAS_BALANCE',
  'INSUFFICIENT_BALANCE',
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
