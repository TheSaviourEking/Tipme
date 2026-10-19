import {
  createParamDecorator,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  isActiveStaff,
  resolveOpsGrant,
  resolveSession,
} from '@tipme/database';
import type { Request } from 'express';
import type { AuthContext } from '../auth/session.guard.js';
import { OPS_COOKIE, readCookie, SESSION_COOKIE } from '../auth/cookies.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';

export interface OpsContext {
  userId: string;
  sessionId: string;
  permissions: Set<string>;
}
export type OpsRequest = Request & { auth?: AuthContext; ops?: OpsContext };

export const OPS_PERMISSION = 'tipme:ops-permission';

// Anyone who is not signed-in staff learns nothing about the admin area: every refusal is a 404.
const hidden = () => new CodedHttpException(404, 'NOT_FOUND');

async function sessionOf(
  database: DatabaseProvider,
  request: Request,
): Promise<AuthContext | null> {
  const token = readCookie(request, SESSION_COOKIE);
  return token ? resolveSession(database.db, token, new Date()) : null;
}

/** Signed in and staff (no grant needed): the enrolment and grant-opening routes. */
@Injectable()
export class StaffGuard implements CanActivate {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OpsRequest>();
    const session = await sessionOf(this.database, request);
    if (!session || !(await isActiveStaff(this.database.db, session.userId)))
      throw hidden();
    request.auth = session;
    return true;
  }
}

/**
 * Recipient session + live admin grant on that same session + the route's permission. Missing
 * session or grant → 404; a permission the role lacks → 403. The server decides, never the UI.
 */
@Injectable()
export class OpsGuard implements CanActivate {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<OpsRequest>();
    const session = await sessionOf(this.database, request);
    const token = readCookie(request, OPS_COOKIE);
    const grant =
      session && token
        ? await resolveOpsGrant(this.database.db, {
            token,
            sessionId: session.sessionId,
          })
        : null;
    if (!session || !grant || grant.userId !== session.userId) throw hidden();
    const permission = this.reflector.getAllAndOverride<string | undefined>(
      OPS_PERMISSION,
      [context.getHandler(), context.getClass()],
    );
    if (!permission || !grant.permissions.has(permission))
      throw new CodedHttpException(403, 'FORBIDDEN');
    request.auth = session;
    request.ops = { ...grant, sessionId: session.sessionId };
    return true;
  }
}

export const CurrentOps = createParamDecorator(
  (_data: unknown, context: ExecutionContext): OpsContext => {
    const ops = context.switchToHttp().getRequest<OpsRequest>().ops;
    if (!ops) throw hidden();
    return ops;
  },
);
