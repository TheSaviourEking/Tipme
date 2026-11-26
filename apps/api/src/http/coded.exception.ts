import { HttpException } from '@nestjs/common';
import type { ApiErrorCode, StudioIssue } from '@tipme/contracts';

/** An HTTP error with a specific public code (the filter keeps its fixed message). */
export class CodedHttpException extends HttpException {
  constructor(
    status: number,
    readonly code: ApiErrorCode,
    /** A fixed code to add to the response, never request data. */
    readonly reason?: string,
    /** Sent as Retry-After, in seconds. */
    readonly retryAfterSeconds?: number,
  ) {
    super(code, status);
  }
}

/** 422 STUDIO_DESIGN_CHECK_FAILED, carrying the server's design check issues to the editor. */
export class StudioCheckFailedException extends CodedHttpException {
  constructor(readonly issues: StudioIssue[]) {
    super(422, 'STUDIO_DESIGN_CHECK_FAILED');
  }
}

/**
 * 400 FEE_WAIVER_CONFIRM_REQUIRED with the live estimate of a kind-wide waiver's monthly cost, so the
 * screen shows the figure and asks once more. `reason` is `confirm_cost` (none confirmed) or
 * `estimate_moved` (the figure sent is no longer the live one).
 */
export class FeeWaiverConfirmException extends CodedHttpException {
  constructor(
    reason: 'confirm_cost' | 'estimate_moved',
    readonly costEstimateMinor: string,
  ) {
    super(400, 'FEE_WAIVER_CONFIRM_REQUIRED', reason);
  }
}
