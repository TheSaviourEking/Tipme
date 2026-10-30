import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorCode, ApiErrorResponse } from '@tipme/contracts';
import {
  OperationError,
  PersistenceError,
  type OperationErrorCode,
} from '@tipme/database';
import type { ErrorReporter, Logger } from '@tipme/observability';
import { RateLimitedException } from '../checkout/rate-limit.guard.js';
import { CodedHttpException } from './coded.exception.js';
import { isRetryablePersistenceError } from '../webhooks/retryable.js';
import { referenceOf } from './reference.js';
import { ValidationFailedException } from './zod-validation.pipe.js';

/** Thrown when Postgres/Redis cannot serve a request in time. */
export class DependencyUnavailableError extends Error {
  override readonly name = 'DependencyUnavailableError';
}

// Fixed messages: framework and parser messages can quote request input.
const messages: Record<ApiErrorCode, string> = {
  VALIDATION_FAILED: 'The request was not valid.',
  UNAUTHORIZED: 'Unauthorized.',
  NOT_FOUND: 'Not found.',
  METHOD_NOT_ALLOWED: 'Method not allowed.',
  PAYLOAD_TOO_LARGE: 'The request body is too large.',
  IDEMPOTENCY_CONFLICT:
    'This Idempotency-Key was already used with a different request.',
  QUOTE_EXPIRED: 'The quote has expired. Please get a new one.',
  QUOTE_ALREADY_USED: 'The quote was already used.',
  TIP_NOT_PAYABLE: 'This tip can no longer be paid.',
  UNAUTHENTICATED: 'Please sign in.',
  FORBIDDEN_ORIGIN: 'This request must come from the TipMe website.',
  CODE_INVALID:
    'That code is not right or has expired. Please check it or ask for a new one.',
  SIGN_IN_LOCKED: 'Too many wrong codes. Please wait 15 minutes and try again.',
  HANDLE_TAKEN: 'That handle is not available. Please choose another.',
  HANDLE_RENAME_LIMIT:
    'Your page already keeps 5 old handles. Choose one of them, or keep your current handle.',
  ALREADY_HAS_PAGE: 'You already have a page.',
  INSUFFICIENT_BALANCE: 'That is more than your available balance.',
  WITHDRAWAL_TOO_SMALL: 'The smallest withdrawal is NGN 1,000.',
  WITHDRAWAL_UNAVAILABLE:
    'Withdrawals are not available yet for tips paid through this payment provider.',
  PRO_REQUIRED: 'Choosing your own tip amounts is part of TipMe Pro.',
  INVALID_IMAGE: 'Please choose a JPEG, PNG or WebP photo.',
  PHONE_TAKEN: 'That number belongs to another account.',
  RECOVERY_PENDING:
    'This number is waiting to be moved to an account. Please try again when the 24 hours are up.',
  HAS_BALANCE:
    'Your page cannot be deleted while money is still confirming or in your balance.',
  PROFILE_NOT_FOUND: 'That profile does not exist.',
  FORBIDDEN: 'Your admin role does not allow this.',
  ENROLMENT_INVALID:
    'That enrolment code is not right or has expired. Ask for a new one with pnpm ops:grant-owner.',
  OPS_LOCKED: 'Too many wrong codes. Admin access is locked for 15 minutes.',
  PAGE_SUSPENDED:
    'TipMe has paused your page, so it cannot go live. See the note on your dashboard.',
  ISSUE_RESOLVED: 'This issue is already resolved.',
  PREVIEW_REQUIRED:
    'This is a private preview. Please sign in with the preview password.',
  RATE_LIMITED: 'Too many requests. Please wait and retry.',
  DEPENDENCY_UNAVAILABLE:
    'A required service is temporarily unavailable. Please retry.',
  EMAIL_VERIFICATION_REQUIRED:
    'Verify your email address before connecting a payment account.',
  PAYMENT_ACCOUNT_REQUIRED:
    'Connect and activate a payment account before accepting tips.',
  EMAIL_TAKEN: 'That email is already used by another TipMe account.',
  NO_CONFIRMED_TEST:
    'Send a test through this provider and confirm it arrived before making it active.',
  PROVIDER_NOT_ALLOWED: 'This provider can’t be made active in production.',
  PAYMENT_START_REJECTED:
    'The payment provider refused to start this payment. Nothing was charged.',
  PROVIDER_OUTCOME_UNKNOWN:
    'The provider may have accepted the request. Do not retry; contact support.',
  INTERNAL_ERROR: 'Something went wrong.',
};

/** Body-parser errors use the `http-errors` shape: a numeric status plus `expose` for client errors. */
function exposedClientStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const { status, expose } = exception as {
    status?: unknown;
    expose?: unknown;
  };
  return typeof status === 'number' &&
    expose === true &&
    status >= 400 &&
    status < 500
    ? status
    : undefined;
}

/** Business outcomes from the PR-005 operations; codes without an entry are internal errors. */
const operationErrors: Partial<
  Record<
    OperationErrorCode,
    { status: number; code: ApiErrorCode; fields?: string[] }
  >
> = {
  IDEMPOTENCY_CONFLICT: { status: 409, code: 'IDEMPOTENCY_CONFLICT' },
  QUOTE_EXPIRED: { status: 409, code: 'QUOTE_EXPIRED' },
  QUOTE_ALREADY_USED: { status: 409, code: 'QUOTE_ALREADY_USED' },
  TIP_NOT_PAYABLE: { status: 409, code: 'TIP_NOT_PAYABLE' },
  HANDLE_TAKEN: { status: 409, code: 'HANDLE_TAKEN' },
  HANDLE_RENAME_LIMIT: { status: 409, code: 'HANDLE_RENAME_LIMIT' },
  ALREADY_HAS_PAGE: { status: 409, code: 'ALREADY_HAS_PAGE' },
  HAS_BALANCE: { status: 409, code: 'HAS_BALANCE' },
  INSUFFICIENT_BALANCE: { status: 409, code: 'INSUFFICIENT_BALANCE' },
  WITHDRAWAL_TOO_SMALL: { status: 409, code: 'WITHDRAWAL_TOO_SMALL' },
  WITHDRAWAL_UNAVAILABLE: { status: 409, code: 'WITHDRAWAL_UNAVAILABLE' },
  PRO_REQUIRED: { status: 403, code: 'PRO_REQUIRED' },
  PHONE_TAKEN: { status: 409, code: 'PHONE_TAKEN' },
  CODE_INVALID: { status: 400, code: 'CODE_INVALID' },
  ENROLMENT_INVALID: { status: 400, code: 'ENROLMENT_INVALID' },
  PAGE_SUSPENDED: { status: 409, code: 'PAGE_SUSPENDED' },
  ISSUE_RESOLVED: { status: 409, code: 'ISSUE_RESOLVED' },
  ISSUE_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  EMAIL_VERIFICATION_REQUIRED: {
    status: 409,
    code: 'EMAIL_VERIFICATION_REQUIRED',
  },
  MARKET_ENTRY_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  NO_PAGE: { status: 404, code: 'NOT_FOUND' },
  PROFILE_NOT_FOUND: { status: 404, code: 'PROFILE_NOT_FOUND' },
  QUOTE_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  AMOUNT_OUT_OF_RANGE: {
    status: 400,
    code: 'VALIDATION_FAILED',
    fields: ['amountMinor'],
  },
  INVALID_INPUT: {
    status: 400,
    code: 'VALIDATION_FAILED',
    fields: ['message'],
  },
  INVALID_TIP_PRESETS: {
    status: 400,
    code: 'VALIDATION_FAILED',
    fields: ['presetsMinor'],
  },
  INVALID_TIP_MINIMUM: {
    status: 400,
    code: 'VALIDATION_FAILED',
    fields: ['minMinor'],
  },
};

function classify(exception: unknown): {
  status: number;
  code: ApiErrorCode;
  fields?: string[];
} {
  if (exception instanceof CodedHttpException)
    return { status: exception.getStatus(), code: exception.code };
  if (exception instanceof OperationError) {
    const mapped = operationErrors[exception.code];
    if (mapped) return mapped;
    return { status: 500, code: 'INTERNAL_ERROR' };
  }
  if (
    exception instanceof PersistenceError &&
    isRetryablePersistenceError(exception)
  ) {
    return { status: 503, code: 'DEPENDENCY_UNAVAILABLE' };
  }
  if (exception instanceof DependencyUnavailableError) {
    return { status: 503, code: 'DEPENDENCY_UNAVAILABLE' };
  }
  const status =
    exception instanceof HttpException
      ? exception.getStatus()
      : exposedClientStatus(exception);
  if (status === undefined) return { status: 500, code: 'INTERNAL_ERROR' };
  if (status === 401) return { status, code: 'UNAUTHORIZED' };
  if (status === 404) return { status, code: 'NOT_FOUND' };
  if (status === 405) return { status, code: 'METHOD_NOT_ALLOWED' };
  if (status === 413) return { status, code: 'PAYLOAD_TOO_LARGE' };
  if (status === 429) return { status, code: 'RATE_LIMITED' };
  if (status === 503) return { status, code: 'DEPENDENCY_UNAVAILABLE' };
  if (status >= 400 && status < 500)
    return { status, code: 'VALIDATION_FAILED' };
  return { status: 500, code: 'INTERNAL_ERROR' };
}

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly logger: Logger,
    private readonly reporter?: ErrorReporter,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    const { status, code, fields } = classify(exception);
    const reference = referenceOf(response);
    if (status >= 500 && code === 'INTERNAL_ERROR') {
      // Name only: messages and stacks can contain request data.
      this.logger.error({
        event: 'http.error',
        error: exception instanceof Error ? exception.name : typeof exception,
        reference,
      });
      // The route pattern, never the URL (it can carry identifiers or query values).
      const route = host
        .switchToHttp()
        .getRequest<{ route?: { path?: string } }>().route?.path;
      this.reporter?.capture(exception, {
        ...(route ? { route } : {}),
        traceId: reference,
      });
    }
    const body: ApiErrorResponse = {
      error: { code, message: messages[code], reference },
    };
    if (exception instanceof ValidationFailedException)
      body.error.fields = exception.fields;
    else if (fields) body.error.fields = fields;
    if (exception instanceof RateLimitedException)
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    response.status(status).json(body);
  }
}
