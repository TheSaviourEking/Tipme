import {
  Catch,
  HttpException,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { Response } from 'express';
import type { ApiErrorCode, ApiErrorResponse } from '@tipme/contracts';
import {
  databaseFailureOf,
  isDatabaseAvailabilityFailure,
  OperationError,
  PersistenceError,
  type DatabaseFailure,
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
  PERMISSION_NOT_HELD:
    'You can only give or take away access you hold yourself.',
  FRESH_CODE_REQUIRED: 'Enter a code from your authenticator to do this.',
  CODE_ALREADY_USED:
    'That code has just been used. Wait for the next one in your app.',
  STAFF_ADMIN_BUSY:
    'Another staff change is in progress and nothing was changed. Please try again in a moment.',
  ISSUE_OWN_ALERT:
    'Someone else has to close this one, because it records your own action. With nobody else, it closes by itself after 30 days.',
  PAYOUT_CHANGED:
    'This withdrawal changed, so nothing was done. Look at it again.',
  APPROVAL_OWN_REQUEST:
    'Someone else has to decide this one, because you asked for it.',
  APPROVAL_NOT_YOURS: 'Only the person who asked can cancel this request.',
  APPROVAL_SUBJECT:
    'Someone else has to decide this one, because it is about you.',
  APPROVAL_CLOSED:
    'This request has already been closed. Nothing more was done.',
  APPROVAL_EXPIRED:
    'This request passed its 24 hours, so it has closed. Nothing ran. Ask again if it is still needed.',
  APPROVAL_STALE:
    'Things have changed since this was asked for, so it stopped and nothing ran. Ask again if it is still needed.',
  APPROVAL_ALREADY_PENDING:
    'You already have this same request waiting. Cancel it first, then you can act.',
  // Changelog (plan 2026-11-05). The routes that return these arrive in later PRs.
  APPROVAL_NO_APPROVER: 'Nobody who can approve this is set up yet.',
  CHANGELOG_SIGNATURE_INVALID: 'The request signature was not accepted.',
  CHANGELOG_EDITED_ELSEWHERE:
    'Someone else changed this entry since you opened it. Reload to see their change.',
  CHANGELOG_TEXT_NOT_ALLOWED:
    'This text can’t be shown to users as it is. Change it and try again.',
  CHANGELOG_NOT_FOUND: 'There is no changelog entry with that number.',
  SELF_ACCESS_CHANGE: 'You can’t change your own access.',
  ROLE_NAME_TAKEN: 'A role with that name already exists.',
  USERNAME_BUILT_IN:
    'TipMe’s own list already reserves this username. It can’t be reserved or released here.',
  USERNAME_RESERVED: 'This username is already reserved.',
  USERNAME_HELD_BY_PAGE:
    'A page has this username, now or as an old one. To take it, ask to take it back.',
  USERNAME_NOT_RESERVED: 'This username isn’t reserved.',
  TAKE_BACK_OPEN: 'This username already has a take-back under way.',
  TAKE_BACK_NOT_FOUND: 'We couldn’t find that take-back.',
  TAKE_BACK_CLOSED: 'This take-back has already finished.',
  ROLE_IN_USE: 'Move everyone off this role before deleting it.',
  ROLE_PROTECTED: 'This built-in role can’t be changed.',
  STAFF_PROTECTED: 'This person’s access can’t be adjusted.',
  STAFF_CHANGED: 'This person’s role just changed. Check it and try again.',
  LAST_OWNER: 'The last active owner can’t be removed or demoted.',
  ROLE_HAS_FORMER_HOLDERS:
    'People who were removed held this role, and their history keeps it, so it can’t be deleted. You can rename it or untick its permissions.',
  STAFF_EMAIL_TAKEN:
    'That mailbox already belongs to staff (dots and +tags count as the same address). To bring back someone removed, use their exact address.',
  STAFF_EMAIL_LOCKED:
    'Staff can’t change their sign-in email here. Contact the owner, who can have it changed.',
  STAFF_PHONE_LOCKED:
    'Staff can’t change their phone number here. Ask an owner.',
  STAFF_CANNOT_DELETE:
    'Staff accounts can’t be deleted. Ask an owner to remove your staff access first.',
  STAFF_ALREADY_ENROLLED:
    'This person has already set up their authenticator. An owner can reset it instead.',
  STAFF_NO_EMAIL:
    'This person has no verified email to send a link to. Use grant-owner on the server.',
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
  HANDLE_CHANGE_PRO_REQUIRED: 'Handle changes are part of TipMe Pro.',
  HANDLE_CHANGE_LIMIT:
    'You’ve used all your handle changes. Contact the TipMe team at support@usetipme.xyz to change it again.',
  ALREADY_HAS_PAGE: 'You already have a page.',
  INSUFFICIENT_BALANCE: 'That is more than your available balance.',
  WITHDRAWAL_TOO_SMALL: 'The smallest withdrawal is NGN 2,000.',
  WITHDRAWAL_UNAVAILABLE:
    'Withdrawals are not available yet for tips paid through this payment provider.',
  WITHDRAWALS_SWITCHED_OFF:
    'Withdrawals are paused for now. Your balance is safe.',
  WITHDRAWALS_PAUSED:
    'Withdrawals are paused while support checks your account. Questions: support@usetipme.xyz',
  PAYOUT_SETUP_NEEDED: 'Finish setting up how you get paid to withdraw.',
  PAYOUT_DESTINATION_NEEDED: 'Add the bank account you want to be paid to.',
  PAYOUT_DESTINATION_REFUSED:
    'The payment provider could not accept this bank account.',
  PAYOUT_PROVIDER_UNAVAILABLE:
    'We can’t reach our payment partner right now. Try again in a few minutes.',
  BANK_CHANGE_HELD:
    'Your sign-in email changed recently, so your bank account can’t be added or changed yet.',
  PRO_REQUIRED: 'Choosing your own tip amounts is part of TipMe Pro.',
  QR_DESIGN_PRO_REQUIRED: 'Saving a Pro QR design is part of TipMe Pro.',
  COVER_DESIGN_PRO_REQUIRED: 'This cover choice is part of TipMe Pro.',
  THANKS_PRO_REQUIRED: 'Card styles and your signature are part of TipMe Pro.',
  SOCIAL_LINK_UNAVAILABLE:
    'OnlyFans and Fansly links can’t be added right now.',
  SOCIAL_LINKS_PRO_REQUIRED:
    'More than 3 links, Pro sites, a featured link and your own order are part of TipMe Pro.',
  QR_ART_PHOTO_REQUIRED:
    'The photo mosaic is made from your page photo. Add a photo to your page first.',
  QR_ART_PHOTO_TOO_LARGE:
    'Your page photo is too large for the photo mosaic. Upload a smaller photo and try again.',
  INVALID_IMAGE: 'Please choose a JPEG, PNG or WebP photo.',
  PHONE_TAKEN: 'That number belongs to another account.',
  RECOVERY_PENDING:
    'This number is waiting to be moved to an account. Please try again when the 24 hours are up.',
  HAS_BALANCE:
    'Your page cannot be deleted while money is still confirming or in your balance.',
  PROFILE_NOT_FOUND: 'That profile does not exist.',
  FORBIDDEN: 'Your admin role does not allow this.',
  ENROLMENT_INVALID:
    'That enrolment code is not right or has expired. Ask an owner for a new one, or use pnpm ops:grant-owner.',
  OPS_LOCKED: 'Too many wrong codes. Admin access is locked for 15 minutes.',
  PAGE_SUSPENDED:
    'TipMe has paused your page, so it cannot go live. See the note on your dashboard.',
  ISSUE_RESOLVED: 'This issue is already resolved.',
  ISSUE_OUTCOME_REQUIRED: 'Choose how this money issue was settled.',
  ISSUE_PAYOUT_UNFINISHED:
    'This withdrawal hasn’t finished. Use “Act on this withdrawal” on the issue page.',
  PREVIEW_REQUIRED:
    'This is a private preview. Please sign in with the preview password.',
  RATE_LIMITED: 'Too many requests. Please wait and retry.',
  LIVE_LIMIT:
    'Too many live connections are open. This page will refresh on its own.',
  LIVE_UNAVAILABLE: 'Live updates are busy. This page will refresh on its own.',
  DEPENDENCY_UNAVAILABLE:
    'A required service is temporarily unavailable. Please retry.',
  EMAIL_VERIFICATION_REQUIRED:
    'Verify your email address before connecting a payment account.',
  PAYMENT_ACCOUNT_REQUIRED:
    'Connect and activate a payment account before accepting tips.',
  EMAIL_TAKEN: 'That email is already used by another TipMe account.',
  EMAIL_INVALID: 'That email address is not valid.',
  UNSUBSCRIBE_INVALID: 'That unsubscribe link is not valid.',
  TOO_MANY_CODES: 'Too many codes were requested for that address.',
  NO_SIGN_IN_EMAIL: 'This account has no sign-in email.',
  SAME_AS_SIGN_IN_EMAIL:
    'Your recovery email must be different from your sign-in email.',
  SIGN_IN_CODE_REQUIRED:
    'Changing your recovery email needs a code sent to your sign-in email.',
  NO_CONFIRMED_TEST:
    'Send a test through this provider and confirm it arrived before making it active.',
  PROVIDER_NOT_ALLOWED: 'This provider can’t be made active in production.',
  PAYMENT_START_REJECTED:
    'The payment provider refused to start this payment. Nothing was charged.',
  TIPPING_NOT_OPEN: 'Tipping opens soon. Nothing was charged.',
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
  HANDLE_CHANGE_PRO_REQUIRED: {
    status: 403,
    code: 'HANDLE_CHANGE_PRO_REQUIRED',
  },
  HANDLE_CHANGE_LIMIT: { status: 409, code: 'HANDLE_CHANGE_LIMIT' },
  ALREADY_HAS_PAGE: { status: 409, code: 'ALREADY_HAS_PAGE' },
  HAS_BALANCE: { status: 409, code: 'HAS_BALANCE' },
  INSUFFICIENT_BALANCE: { status: 409, code: 'INSUFFICIENT_BALANCE' },
  WITHDRAWAL_TOO_SMALL: { status: 409, code: 'WITHDRAWAL_TOO_SMALL' },
  WITHDRAWAL_UNAVAILABLE: { status: 409, code: 'WITHDRAWAL_UNAVAILABLE' },
  WITHDRAWALS_PAUSED: { status: 409, code: 'WITHDRAWALS_PAUSED' },
  WITHDRAWALS_SWITCHED_OFF: { status: 409, code: 'WITHDRAWALS_SWITCHED_OFF' },
  PAYOUT_SETUP_NEEDED: { status: 409, code: 'PAYOUT_SETUP_NEEDED' },
  PAYOUT_DESTINATION_NEEDED: {
    status: 409,
    code: 'PAYOUT_DESTINATION_NEEDED',
  },
  PAYOUT_DESTINATION_REFUSED: {
    status: 422,
    code: 'PAYOUT_DESTINATION_REFUSED',
  },
  BANK_CHANGE_HELD: { status: 409, code: 'BANK_CHANGE_HELD' },
  PAYOUT_PROVIDER_UNAVAILABLE: {
    status: 503,
    code: 'PAYOUT_PROVIDER_UNAVAILABLE',
  },
  PRO_REQUIRED: { status: 403, code: 'PRO_REQUIRED' },
  QR_DESIGN_PRO_REQUIRED: { status: 403, code: 'QR_DESIGN_PRO_REQUIRED' },
  COVER_DESIGN_PRO_REQUIRED: {
    status: 403,
    code: 'COVER_DESIGN_PRO_REQUIRED',
  },
  THANKS_PRO_REQUIRED: { status: 403, code: 'THANKS_PRO_REQUIRED' },
  SOCIAL_LINK_UNAVAILABLE: { status: 409, code: 'SOCIAL_LINK_UNAVAILABLE' },
  SOCIAL_LINKS_PRO_REQUIRED: {
    status: 403,
    code: 'SOCIAL_LINKS_PRO_REQUIRED',
  },
  PHONE_TAKEN: { status: 409, code: 'PHONE_TAKEN' },
  CODE_INVALID: { status: 400, code: 'CODE_INVALID' },
  ENROLMENT_INVALID: { status: 400, code: 'ENROLMENT_INVALID' },
  PAGE_SUSPENDED: { status: 409, code: 'PAGE_SUSPENDED' },
  ISSUE_RESOLVED: { status: 409, code: 'ISSUE_RESOLVED' },
  ISSUE_OUTCOME_REQUIRED: { status: 422, code: 'ISSUE_OUTCOME_REQUIRED' },
  ISSUE_PAYOUT_UNFINISHED: { status: 409, code: 'ISSUE_PAYOUT_UNFINISHED' },
  ISSUE_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  EMAIL_VERIFICATION_REQUIRED: {
    status: 409,
    code: 'EMAIL_VERIFICATION_REQUIRED',
  },
  MARKET_ENTRY_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  PERMISSION_NOT_HELD: { status: 403, code: 'PERMISSION_NOT_HELD' },
  FRESH_CODE_REQUIRED: { status: 403, code: 'FRESH_CODE_REQUIRED' },
  STAFF_ADMIN_BUSY: { status: 503, code: 'STAFF_ADMIN_BUSY' },
  ISSUE_OWN_ALERT: { status: 403, code: 'ISSUE_OWN_ALERT' },
  APPROVAL_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  APPROVAL_OWN_REQUEST: { status: 403, code: 'APPROVAL_OWN_REQUEST' },
  APPROVAL_NOT_YOURS: { status: 403, code: 'APPROVAL_NOT_YOURS' },
  APPROVAL_SUBJECT: { status: 403, code: 'APPROVAL_SUBJECT' },
  APPROVAL_CLOSED: { status: 409, code: 'APPROVAL_CLOSED' },
  APPROVAL_EXPIRED: { status: 409, code: 'APPROVAL_EXPIRED' },
  APPROVAL_ALREADY_PENDING: { status: 409, code: 'APPROVAL_ALREADY_PENDING' },
  RECOVERY_STAFF_ACCOUNT: { status: 409, code: 'FORBIDDEN' },
  PAYOUT_CHANGED: { status: 409, code: 'PAYOUT_CHANGED' },
  NO_CONFIRMED_TEST: { status: 409, code: 'NO_CONFIRMED_TEST' },
  PROVIDER_NOT_ALLOWED: { status: 409, code: 'PROVIDER_NOT_ALLOWED' },
  PROVIDER_STATUS_UNKNOWN: { status: 503, code: 'DEPENDENCY_UNAVAILABLE' },
  SELF_ACCESS_CHANGE: { status: 403, code: 'SELF_ACCESS_CHANGE' },
  ROLE_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  ROLE_NAME_TAKEN: { status: 409, code: 'ROLE_NAME_TAKEN' },
  USERNAME_BUILT_IN: { status: 409, code: 'USERNAME_BUILT_IN' },
  USERNAME_RESERVED: { status: 409, code: 'USERNAME_RESERVED' },
  USERNAME_HELD_BY_PAGE: { status: 409, code: 'USERNAME_HELD_BY_PAGE' },
  USERNAME_NOT_RESERVED: { status: 404, code: 'USERNAME_NOT_RESERVED' },
  TAKE_BACK_OPEN: { status: 409, code: 'TAKE_BACK_OPEN' },
  TAKE_BACK_NOT_FOUND: { status: 404, code: 'TAKE_BACK_NOT_FOUND' },
  TAKE_BACK_CLOSED: { status: 409, code: 'TAKE_BACK_CLOSED' },
  ROLE_IN_USE: { status: 409, code: 'ROLE_IN_USE' },
  ROLE_PROTECTED: { status: 409, code: 'ROLE_PROTECTED' },
  STAFF_NOT_FOUND: { status: 404, code: 'NOT_FOUND' },
  STAFF_PROTECTED: { status: 409, code: 'STAFF_PROTECTED' },
  STAFF_CHANGED: { status: 409, code: 'STAFF_CHANGED' },
  LAST_OWNER: { status: 409, code: 'LAST_OWNER' },
  ROLE_HAS_FORMER_HOLDERS: { status: 409, code: 'ROLE_HAS_FORMER_HOLDERS' },
  STAFF_EMAIL_TAKEN: { status: 409, code: 'STAFF_EMAIL_TAKEN' },
  STAFF_NO_EMAIL: { status: 409, code: 'STAFF_NO_EMAIL' },
  STAFF_EMAIL_LOCKED: { status: 409, code: 'STAFF_EMAIL_LOCKED' },
  STAFF_PHONE_LOCKED: { status: 409, code: 'STAFF_PHONE_LOCKED' },
  STAFF_CANNOT_DELETE: { status: 409, code: 'STAFF_CANNOT_DELETE' },
  STAFF_ALREADY_ENROLLED: { status: 409, code: 'STAFF_ALREADY_ENROLLED' },
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
  // The thank-you line (PUT /v1/me/thanks): its own code, as INVALID_INPUT points at `message`.
  INVALID_THANKS_LINE: {
    status: 400,
    code: 'VALIDATION_FAILED',
    fields: ['line'],
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
  // A read outside `guarded` that hit the same wall: still a retryable answer, not a 500.
  if (isDatabaseAvailabilityFailure(exception)) {
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

/** Fixed words and codes only: what the next person needs to tell one 503 from another. */
function dependencyFields(failure: DatabaseFailure | null) {
  if (!failure) return { cause: 'not_database' };
  return {
    cause: failure.kind,
    ...(failure.sqlState ? { sql_state: failure.sqlState } : {}),
    ...(failure.errno ? { errno: failure.errno } : {}),
    ...(failure.causeName ? { cause_name: failure.causeName } : {}),
  };
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
    if (code === 'DEPENDENCY_UNAVAILABLE') {
      const route = host
        .switchToHttp()
        .getRequest<{ route?: { path?: string } }>().route?.path;
      const failure = databaseFailureOf(exception);
      this.logger.warn({
        event: 'http.dependency_unavailable',
        ...dependencyFields(failure),
        ...(route ? { route } : {}),
        reference,
      });
      // A database failure rebuilt from its fixed words, so the driver's message can't travel.
      if (failure)
        this.reporter?.capture(
          new PersistenceError(failure.sqlState, failure),
          { ...(route ? { route } : {}), traceId: reference },
        );
    }
    const body: ApiErrorResponse = {
      error: { code, message: messages[code], reference },
    };
    if (exception instanceof ValidationFailedException)
      body.error.fields = exception.fields;
    else if (fields) body.error.fields = fields;
    if (exception instanceof CodedHttpException && exception.reason)
      body.error.reason = exception.reason;
    if (
      exception instanceof RateLimitedException ||
      (exception instanceof CodedHttpException && exception.retryAfterSeconds)
    )
      response.setHeader('Retry-After', String(exception.retryAfterSeconds));
    response.status(status).json(body);
  }
}
