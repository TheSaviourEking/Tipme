import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  opsBusinessListQuerySchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsBusinessContact,
  type OpsBusinessDetail,
  type OpsBusinessListQuery,
  type OpsBusinessRow,
  type OpsReasonRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  listOpsBusinesses,
  opsBusinessDetail,
  requestSeriousAction,
  restoreBusiness,
  revealBusinessContact,
  suspendBusiness,
  type SeriousActionServices,
} from '@tipme/database';
import { BusinessEnabledGuard } from '../business/business-enabled.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { signalBusiness } from '../business/business-live.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const businessIdOf = (value: string) => {
  if (!UUID.test(value))
    throw new CodedHttpException(404, 'BUSINESS_NOT_FOUND');
  return value;
};

/**
 * TipMe for businesses, lane B2: staff look businesses up with contacts masked, reveal a contact
 * with a reason (`private.view`), suspend and restore (`businesses.manage`, a reason, audited), and
 * verify one as a serious action (`business.verify`). Every change refreshes the public `/b/` pages.
 */
@Controller('v1/ops/businesses')
@UseGuards(BusinessEnabledGuard)
export class OpsBusinessesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    // Optional: integration tests may build this controller without the live module.
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  @Get()
  @OpsPermission('search.view')
  @Header('Cache-Control', 'private, no-store')
  async list(
    @Query(new ZodValidationPipe(opsBusinessListQuerySchema))
    query: OpsBusinessListQuery,
  ): Promise<ApiDataResponse<OpsBusinessRow[]>> {
    return { data: await listOpsBusinesses(this.database.db, query) };
  }

  @Get(':id')
  @OpsPermission('search.view')
  @Header('Cache-Control', 'private, no-store')
  async detail(
    @Param('id') id: string,
  ): Promise<ApiDataResponse<OpsBusinessDetail>> {
    return {
      data: await opsBusinessDetail(this.database.db, businessIdOf(id)),
    };
  }

  /** The full contact and the managers' emails: audited with the reason (access-control rule 6). */
  @Post(':id/reveal')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('private.view')
  @Header('Cache-Control', 'private, no-store')
  async reveal(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsBusinessContact>> {
    return {
      data: await revealBusinessContact(this.database.db, {
        staffUserId: ops.userId,
        businessId: businessIdOf(id),
        reason: body.reason,
      }),
    };
  }

  @Post(':id/suspend')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('businesses.manage')
  async suspend(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsBusinessDetail>> {
    const businessId = businessIdOf(id);
    const { slug, changed } = await suspendBusiness(this.database.db, {
      staffUserId: ops.userId,
      businessId,
      reason: body.reason,
    });
    // After the commit: the location and staff pages stop at once (M11).
    if (changed) {
      this.revalidator.revalidateBusiness(slug);
      signalBusiness(this.database.db, this.publishLive, { businessId });
    }
    return { data: await opsBusinessDetail(this.database.db, businessId) };
  }

  @Post(':id/restore')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('businesses.manage')
  async restore(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsBusinessDetail>> {
    const businessId = businessIdOf(id);
    const { slug, changed } = await restoreBusiness(this.database.db, {
      staffUserId: ops.userId,
      businessId,
      reason: body.reason,
    });
    if (changed) {
      this.revalidator.revalidateBusiness(slug);
      signalBusiness(this.database.db, this.publishLive, { businessId });
    }
    return { data: await opsBusinessDetail(this.database.db, businessId) };
  }

  /** Two people when possible (202 while it waits); a lone admin acts alone, with the alert. */
  @Post(':id/verify')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('businesses.manage')
  async verify(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<(OpsBusinessDetail & OpsActedAlone) | OpsSeriousPending>
  > {
    const businessId = businessIdOf(id);
    const answer = pendingOr<{ revalidateBusiness: string }>(
      await requestSeriousAction(this.database.db, {
        name: 'business.verify',
        payload: { businessId },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    if ('pending' in answer) return { data: answer.pending };
    this.revalidator.revalidateBusiness(answer.result.revalidateBusiness);
    signalBusiness(this.database.db, this.publishLive, { businessId });
    return {
      data: {
        ...(await opsBusinessDetail(this.database.db, businessId)),
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }
}
