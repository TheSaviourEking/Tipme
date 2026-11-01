import {
  applyDecorators,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { FRESH_CODE_WINDOW_MS } from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import type { OpsRequest } from './ops.guard.js';

export const FRESH_CODE = 'tipme:ops-fresh-code';

/**
 * So an unattended laptop can't act: the grant must have had an authenticator code entered recently.
 * Answers on what OpsGuard read for this request, and refuses if OpsGuard hasn't run.
 */
@Injectable()
export class FreshCodeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const { ops } = context.switchToHttp().getRequest<OpsRequest>();
    if (!ops) throw new CodedHttpException(404, 'NOT_FOUND');
    const enteredAt = ops.lastTotpAt?.getTime();
    if (
      enteredAt === undefined ||
      Date.now() - enteredAt > FRESH_CODE_WINDOW_MS
    )
      throw new CodedHttpException(403, 'FRESH_CODE_REQUIRED');
    return true;
  }
}

/** Goes above `@OpsPermission(...)`: decorators apply bottom-up, and OpsGuard has to run first. */
export const FreshCode = () =>
  applyDecorators(SetMetadata(FRESH_CODE, true), UseGuards(FreshCodeGuard));
