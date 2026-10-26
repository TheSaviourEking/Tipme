import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from '@nestjs/common';
import {
  opsFeeFreeGrantSchema,
  opsPageFeeSchema,
  opsPagePlanSchema,
  type ApiDataResponse,
  type OpsFeeFreeGrantRequest,
  type OpsPage,
  type OpsPageFeeRequest,
  type OpsPagePlanRequest,
  type OpsPagePricing,
} from '@tipme/contracts';
import {
  grantFeeFreeTips,
  opsPageByHandle,
  pagePricing,
  setAccountFee,
  setPagePlan,
} from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Free and Pro (PR-012): staff look a page up and change its plan. Staff also set one page's
 * fee and grant fee-free tips (ADR-0014); nothing about pricing is automatic. No billing; audited.
 */
@Controller('v1/ops/pages')
export class OpsPagesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
  ) {}

  @Get(':handle')
  @OpsPermission('pages.plan')
  async page(
    @Param('handle') handle: string,
  ): Promise<ApiDataResponse<OpsPage>> {
    const page = await opsPageByHandle(this.database.db, handle);
    if (!page) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: page };
  }

  @Post(':profileId/plan')
  @HttpCode(200)
  @OpsPermission('pages.plan')
  async plan(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsPagePlanSchema)) body: OpsPagePlanRequest,
  ): Promise<ApiDataResponse<OpsPage>> {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const { handleLower, changed, ...page } = await setPagePlan(
      this.database.db,
      {
        staffUserId: ops.userId,
        profileId,
        plan: body.plan,
        reason: body.reason,
      },
    );
    // The public page's amounts change with the plan.
    if (changed) this.revalidator.revalidate(handleLower);
    return { data: page };
  }

  @Get(':profileId/pricing')
  @OpsPermission('fees.manage')
  async pricing(
    @Param('profileId') profileId: string,
  ): Promise<ApiDataResponse<OpsPagePricing>> {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const pricing = await pagePricing(this.database.db, profileId);
    if (!pricing) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: pricing };
  }

  @Post(':profileId/fee')
  @HttpCode(200)
  @OpsPermission('fees.manage')
  async fee(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsPageFeeSchema)) body: OpsPageFeeRequest,
  ): Promise<ApiDataResponse<OpsPagePricing>> {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const { handle } = await setAccountFee(this.database.db, {
      staffUserId: ops.userId,
      profileId,
      feeBps: body.feeBps,
      reason: body.reason,
    });
    // The public page shows what the recipient receives after fees.
    this.revalidator.revalidate(handle.toLowerCase());
    return { data: (await pagePricing(this.database.db, profileId))! };
  }

  @Post(':profileId/fee-free')
  @HttpCode(200)
  @OpsPermission('fees.manage')
  async feeFree(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsFeeFreeGrantSchema))
    body: OpsFeeFreeGrantRequest,
  ): Promise<ApiDataResponse<OpsPagePricing>> {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    await grantFeeFreeTips(this.database.db, {
      staffUserId: ops.userId,
      profileId,
      count: body.count,
      reason: body.reason,
    });
    return { data: (await pagePricing(this.database.db, profileId))! };
  }
}
