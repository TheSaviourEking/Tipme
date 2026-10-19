import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { resolveSession } from '@tipme/database';
import type { Request } from 'express';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { readCookie, SESSION_COOKIE } from './cookies.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
}
type AuthedRequest = Request & { auth?: AuthContext };

/** Requires a live session cookie; attaches `request.auth`. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    const token = readCookie(request, SESSION_COOKIE);
    const session = token
      ? await resolveSession(this.database.db, token, new Date())
      : null;
    if (!session) throw new CodedHttpException(401, 'UNAUTHENTICATED');
    request.auth = session;
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthContext => {
    const auth = context.switchToHttp().getRequest<AuthedRequest>().auth;
    if (!auth) throw new CodedHttpException(401, 'UNAUTHENTICATED');
    return auth;
  },
);
