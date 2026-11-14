import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import type { ApiDataResponse, MyAccount } from '@tipme/contracts';
import { myAccount } from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentUser, SessionGuard, type AuthContext } from './session.guard.js';

/**
 * Business sign-up, Task D1: the login's own account. A session is all it needs (never a page),
 * so the dashboard can tell a business-only login from someone who hasn't chosen a handle yet.
 */
@Controller('v1/me')
export class AccountController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get('account')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'private, no-store')
  async account(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyAccount>> {
    const account = await myAccount(this.database.db, auth.userId);
    if (!account) throw new CodedHttpException(401, 'UNAUTHENTICATED');
    return { data: account };
  }
}
