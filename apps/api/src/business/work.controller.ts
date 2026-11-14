import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  invitationAnswerSchema,
  invitationBlockSchema,
  memberDisplaySchema,
  type ApiDataResponse,
  type InvitationAccepted,
  type InvitationAnswer,
  type InvitationBlock,
  type InvitationPreview,
  type MemberDisplay,
  type MyInvitations,
  type MyMembership,
} from '@tipme/contracts';
import {
  acceptBusinessInvitation,
  declineBusinessInvitation,
  leaveBusiness,
  myInvitations,
  myWork,
  previewBusinessInvitation,
  setInvitationBlock,
  updateMyMembership,
} from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { signalBusiness } from './business-live.js';

/**
 * Lane B3: the Work page. An invitation's code travels only in a request body (never a URL), and
 * every answer to a bad code is the same INVITATION_INVALID.
 */
@Controller('v1/me/work')
@UseGuards(BusinessEnabledGuard, SessionGuard, CsrfGuard)
export class WorkController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    // Optional: integration tests may build this controller without the live module.
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async work(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyMembership[]>> {
    return { data: await myWork(this.database.db, auth.userId) };
  }

  @Get('invitations')
  @Header('Cache-Control', 'private, no-store')
  async invitations(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyInvitations>> {
    return { data: await myInvitations(this.database.db, auth.userId) };
  }

  @Post('invitations/preview')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  async preview(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(invitationAnswerSchema)) body: InvitationAnswer,
  ): Promise<ApiDataResponse<InvitationPreview>> {
    return {
      data: await previewBusinessInvitation(
        this.database.db,
        auth.userId,
        body,
      ),
    };
  }

  @Post('invitations/accept')
  @HttpCode(200)
  async accept(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(invitationAnswerSchema)) body: InvitationAnswer,
  ): Promise<ApiDataResponse<InvitationAccepted>> {
    const data = await acceptBusinessInvitation(
      this.database.db,
      auth.userId,
      body,
      new Date(),
      { enforceLimits: this.config.BUSINESS_PRO_ENABLED },
    );
    signalBusiness(
      this.database.db,
      this.publishLive,
      data.kind === 'staff'
        ? { memberId: data.membership.memberId }
        : { businessId: data.businessId },
    );
    return { data };
  }

  @Post('invitations/decline')
  @HttpCode(204)
  async decline(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(invitationAnswerSchema)) body: InvitationAnswer,
  ): Promise<void> {
    await declineBusinessInvitation(this.database.db, auth.userId, body);
  }

  /** The invited person stops (or allows again) invitations from one business. */
  @Put('invitation-blocks/:businessId')
  @HttpCode(204)
  async block(
    @CurrentUser() auth: AuthContext,
    @Param('businessId') businessId: string,
    @Body(new ZodValidationPipe(invitationBlockSchema)) body: InvitationBlock,
  ): Promise<void> {
    await setInvitationBlock(
      this.database.db,
      auth.userId,
      businessId,
      body.blocked,
    );
  }

  @Patch(':memberId')
  async display(
    @CurrentUser() auth: AuthContext,
    @Param('memberId') memberId: string,
    @Body(new ZodValidationPipe(memberDisplaySchema)) body: MemberDisplay,
  ): Promise<ApiDataResponse<MyMembership>> {
    const data = await updateMyMembership(
      this.database.db,
      auth.userId,
      memberId,
      body,
    );
    signalBusiness(this.database.db, this.publishLive, { memberId });
    return { data };
  }

  @Post(':memberId/leave')
  @HttpCode(204)
  async leave(
    @CurrentUser() auth: AuthContext,
    @Param('memberId') memberId: string,
  ): Promise<void> {
    await leaveBusiness(this.database.db, auth.userId, memberId);
    signalBusiness(this.database.db, this.publishLive, { memberId });
  }
}
