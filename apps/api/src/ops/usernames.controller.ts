import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  opsReasonSchema,
  opsUsernameReserveSchema,
  opsUsernamesQuerySchema,
  type ApiDataResponse,
  type OpsReasonRequest,
  type OpsReservation,
  type OpsUsernameCheck,
  type OpsUsernameReserveRequest,
  type OpsUsernamesList,
  type OpsUsernamesQuery,
} from '@tipme/contracts';
import {
  checkUsername,
  listUsernames,
  releaseUsername,
  reserveUsername,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { FreshCode } from './fresh-code.guard.js';
import { OpsPermission } from './permission.decorator.js';

/**
 * Staff reserve and release usernames (username reservation spec, section 4). Every route needs
 * `usernames.manage` and a fresh code, whatever the screens show; reserve and release are instant
 * and audited. Sign-up and handle changes then refuse a reserved name (profiles.ts).
 */
@Controller('v1/ops/usernames')
export class OpsUsernamesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async list(
    @Query(new ZodValidationPipe(opsUsernamesQuerySchema))
    query: OpsUsernamesQuery,
  ): Promise<ApiDataResponse<OpsUsernamesList>> {
    return {
      data: await listUsernames(this.database.db, {
        ...(query.q === undefined ? {} : { q: query.q }),
        ...(query.state === undefined ? {} : { state: query.state }),
      }),
    };
  }

  @Get('check/:name')
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async check(
    @Param('name') name: string,
  ): Promise<ApiDataResponse<OpsUsernameCheck>> {
    return { data: await checkUsername(this.database.db, name, new Date()) };
  }

  @Post()
  @HttpCode(201)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async reserve(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsUsernameReserveSchema))
    body: OpsUsernameReserveRequest,
  ): Promise<ApiDataResponse<OpsReservation>> {
    return {
      data: await reserveUsername(this.database.db, {
        staffId: ops.userId,
        name: body.name,
        reason: body.reason,
      }),
    };
  }

  @Post(':name/release')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('usernames.manage')
  async release(
    @CurrentOps() ops: OpsContext,
    @Param('name') name: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ name: string }>> {
    return {
      data: await releaseUsername(this.database.db, {
        staffId: ops.userId,
        name,
        reason: body.reason,
      }),
    };
  }
}
