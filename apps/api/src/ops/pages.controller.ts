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
  Res,
} from '@nestjs/common';
import {
  OPS_PAGE_IMAGES,
  opsFeeFreeGrantSchema,
  opsHandleChangesGrantSchema,
  opsPageFeeSchema,
  opsPagePlanSchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsFeeFreeGrantRequest,
  type OpsHandleChangesGrantRequest,
  type OpsPage,
  type OpsPageFeeRequest,
  type OpsPageImage,
  type OpsPagePlanRequest,
  type OpsPagePricing,
  type OpsReasonRequest,
} from '@tipme/contracts';
import {
  grantFeeFreeTips,
  grantHandleChanges,
  opsPageByHandle,
  pagePricing,
  setAccountFee,
  setPagePlan,
  staffRemovePageImage,
  staffViewPageImage,
  type MailSealing,
  type PhotoStore,
} from '@tipme/database';
import type { Response } from 'express';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { sendPrivateImage } from '../profiles/image-upload.js';
import { PHOTO_STORE } from '../profiles/photo-store.provider.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidOf = (value: string) => {
  if (!UUID.test(value)) throw new CodedHttpException(404, 'NOT_FOUND');
  return value;
};
const imageOf = (value: string): OpsPageImage => {
  const image = OPS_PAGE_IMAGES.find((known) => known === value);
  if (!image) throw new CodedHttpException(404, 'NOT_FOUND');
  return image;
};

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
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
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

  /**
   * Staff review a page's image, whatever the page's state: a paused page's cover is exactly what
   * they may need to see. Each view is audited, and nothing is cached.
   */
  @Get(':profileId/images/:image')
  @OpsPermission('pages.suspend')
  @Header('X-Content-Type-Options', 'nosniff')
  async image(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Param('image') image: string,
    @Res() response: Response,
  ): Promise<void> {
    sendPrivateImage(
      response,
      await staffViewPageImage(
        this.database.db,
        {
          staffUserId: ops.userId,
          profileId: uuidOf(profileId),
          image: imageOf(image),
        },
        this.photos ?? undefined,
      ),
    );
  }

  /** Takes down one image and leaves the page up: pausing stops the person's tips too. */
  @Post(':profileId/images/:image/remove')
  @HttpCode(200)
  @OpsPermission('pages.suspend')
  async removeImage(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Param('image') image: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ removed: boolean }>> {
    const { handle, changed } = await staffRemovePageImage(this.database.db, {
      staffUserId: ops.userId,
      profileId: uuidOf(profileId),
      image: imageOf(image),
      reason: body.reason,
      sealing: this.sealing,
      store: this.photos ?? undefined,
    });
    if (changed) this.revalidator.revalidate(handle);
    return { data: { removed: changed } };
  }

  /** More handle changes for one page; no public effect, so nothing to refresh. */
  @Post(':handle/handle-changes')
  @HttpCode(200)
  @OpsPermission('pages.plan')
  async handleChanges(
    @CurrentOps() ops: OpsContext,
    @Param('handle') handle: string,
    @Body(new ZodValidationPipe(opsHandleChangesGrantSchema))
    body: OpsHandleChangesGrantRequest,
  ): Promise<ApiDataResponse<{ allowed: number }>> {
    return {
      data: await grantHandleChanges(this.database.db, {
        staffId: ops.userId,
        handle,
        extra: body.extra,
        reason: body.reason,
      }),
    };
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
