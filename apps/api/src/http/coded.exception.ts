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
