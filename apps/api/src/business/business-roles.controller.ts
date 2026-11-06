import { Controller, Get, Header, Inject, UseGuards } from '@nestjs/common';
import type { ApiDataResponse, MyBusinessRoles } from '@tipme/contracts';
import { myBusinessRoles } from '@tipme/database';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { DatabaseProvider } from '../infra/database.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/** PR B0: what the dashboard needs to show the Business and Work links. */
@Controller('v1/me')
@UseGuards(BusinessEnabledGuard)
export class BusinessRolesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get('business-roles')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'private, no-store')
  async roles(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyBusinessRoles>> {
    return { data: await myBusinessRoles(this.database.db, auth.userId) };
  }
}
