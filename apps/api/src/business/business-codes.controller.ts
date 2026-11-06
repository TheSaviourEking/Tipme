import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  UseGuards,
} from '@nestjs/common';
import type { ApiDataResponse, BusinessCodes } from '@tipme/contracts';
import { businessCodes } from '@tipme/database';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { DatabaseProvider } from '../infra/database.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * Lane B8 (PR B8): the location signs and staff badges a manager may print. A read, so no CSRF; a
 * business someone doesn't manage answers 404 like an unknown one (rule 2), and nothing is listed
 * until TipMe verifies the business (M12, `BUSINESS_NOT_VERIFIED`).
 */
@Controller('v1/me/businesses')
@UseGuards(BusinessEnabledGuard, SessionGuard)
export class BusinessCodesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get(':id/codes')
  @Header('Cache-Control', 'private, no-store')
  async codes(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<BusinessCodes>> {
    return { data: await businessCodes(this.database.db, auth.userId, id) };
  }
}
