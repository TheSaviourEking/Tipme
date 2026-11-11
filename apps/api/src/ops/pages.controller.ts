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
import type { Response } from 'express';
import {
  OPS_PAGE_IMAGES,
  opsFeeFreeGrantSchema,
  OPS_PAGE_LOOKUP_PERMISSIONS,
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
  type OpsActedAlone,
  type OpsPagePricing,
  type OpsPageProStatus,
  type OpsReasonRequest,
  type OpsSeriousPending,
  type OpsWithdrawalFreeze,
  type OpsWithdrawalFreezeState,
} from '@tipme/contracts';
import {
  freezeWithdrawals,
  grantHandleChanges,
  opsPageByHandle,
  opsPageProStatus,
  pagePricing,
  requestSeriousAction,
  type SeriousActionServices,
  setPagePlan,
  staffRemovePageImage,
  staffViewPageImage,
  type MailSealing,
  type PhotoStore,
  withdrawalFreezeState,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { sendPrivateImage } from '../profiles/image-upload.js';
import { PHOTO_STORE } from '../profiles/photo-store.provider.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { FreshCode } from './fresh-code.guard.js';
import { OpsAnyStaff, OpsPermission } from './permission.decorator.js';

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
const holdsOneOf = (held: ReadonlySet<string>, wanted: readonly string[]) =>
  wanted.some((permission) => held.has(permission));

@Controller('v1/ops/pages')
export class OpsPagesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  @Get(':handle')
  @OpsAnyStaff()
  async page(
    @CurrentOps() ops: OpsContext,
    @Param('handle') handle: string,
  ): Promise<ApiDataResponse<OpsPage>> {
    if (!holdsOneOf(ops.permissions, OPS_PAGE_LOOKUP_PERMISSIONS))
      throw new CodedHttpException(403, 'FORBIDDEN');
    const page = await opsPageByHandle(this.database.db, handle);
    if (!page) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: page };
  }

  @Post(':profileId/plan')
  @HttpCode(200)
  @FreshCode()
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
    // The public page's amounts change with the plan, and so does the owner's open dashboard.
    if (changed) {
      this.revalidator.revalidate(handleLower);
      void this.publishLive({
        to: { profile: profileId },
        type: 'profile.changed',
      });
    }
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
    if (changed) {
      this.revalidator.revalidate(handle);
      void this.publishLive({
        to: { profile: profileId },
        type: 'profile.changed',
      });
    }
    return { data: { removed: changed } };
  }

  /** More handle changes for one page; no public effect, so nothing to refresh. */
  @Post(':handle/handle-changes')
  @HttpCode(200)
  @FreshCode()
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

  /**
   * Paid Pro (ADR-0015): why the page is Pro (a staff grant or a paid month) and until when.
   * Billing details, so for whoever changes plans; the page lookup itself stays public-level.
   */
  @Get(':profileId/pro')
  @OpsPermission('pages.plan')
  async pro(
    @Param('profileId') profileId: string,
  ): Promise<ApiDataResponse<OpsPageProStatus>> {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: await opsPageProStatus(this.database.db, profileId) };
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

  @Get(':profileId/withdrawal-freeze')
  @OpsPermission('payouts.resolve')
  async freezeState(
    @Param('profileId') profileId: string,
  ): Promise<ApiDataResponse<OpsWithdrawalFreezeState>> {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    return {
      data: await withdrawalFreezeState(this.database.db, { profileId }),
    };
  }

  /** A reported account takeover: stops withdrawals until the issue it opens is resolved. */
  @Post(':profileId/withdrawal-freeze')
  @HttpCode(200)
  @OpsPermission('payouts.resolve')
  async freeze(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsWithdrawalFreeze>> {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    return {
      data: await freezeWithdrawals(this.database.db, {
        staffUserId: ops.userId,
        profileId,
        reason: body.reason,
      }),
    };
  }

  @Post(':profileId/fee')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('fees.manage')
  async fee(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsPageFeeSchema)) body: OpsPageFeeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<(OpsPagePricing & OpsActedAlone) | OpsSeriousPending>
  > {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const answer = pendingOr<{ revalidateHandle: string }>(
      await requestSeriousAction(this.database.db, {
        name: 'fee.change',
        payload: { profileId, feeBps: body.feeBps },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    if ('pending' in answer) return { data: answer.pending };
    // After the commit. The public page shows what the recipient receives after fees.
    this.revalidator.revalidate(answer.result.revalidateHandle);
    return {
      data: {
        ...(await pagePricing(this.database.db, profileId))!,
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }

  @Post(':profileId/fee-free')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('fees.manage')
  async feeFree(
    @CurrentOps() ops: OpsContext,
    @Param('profileId') profileId: string,
    @Body(new ZodValidationPipe(opsFeeFreeGrantSchema))
    body: OpsFeeFreeGrantRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<(OpsPagePricing & OpsActedAlone) | OpsSeriousPending>
  > {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const answer = pendingOr(
      await requestSeriousAction(this.database.db, {
        name: 'fee.free',
        payload: { profileId, count: body.count },
        actorId: ops.userId,
        grantId: ops.grantId,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    if ('pending' in answer) return { data: answer.pending };
    return {
      data: {
        ...(await pagePricing(this.database.db, profileId))!,
        ...(answer.result.actedAlone ? { actedAlone: true as const } : {}),
      },
    };
  }
}
