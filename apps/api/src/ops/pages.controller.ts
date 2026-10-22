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
  opsPagePlanSchema,
  type ApiDataResponse,
  type OpsPage,
  type OpsPagePlanRequest,
} from '@tipme/contracts';
import { opsPageByHandle, setPagePlan } from '@tipme/database';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Free and Pro (PR-012): staff look a page up and change its plan. No billing; audited. */
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
}
