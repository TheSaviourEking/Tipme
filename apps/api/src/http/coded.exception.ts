import { HttpException } from '@nestjs/common';
import type { ApiErrorCode } from '@tipme/contracts';

/** An HTTP error with a specific public code (the filter keeps its fixed message). */
export class CodedHttpException extends HttpException {
  constructor(
    status: number,
    readonly code: ApiErrorCode,
  ) {
    super(code, status);
  }
}
