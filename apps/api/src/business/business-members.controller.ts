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
  UseGuards,
} from '@nestjs/common';
import {
  invitationRequestSchema,
  inviteeQuerySchema,
  type ApiDataResponse,
  type InvitationCreated,
  type InvitationRequest,
  type InvitationRow,
  type InviteeCard,
  type MemberRow,
} from '@tipme/contracts';
import {
  inviteToBusiness,
  listBusinessInvitations,
  listMembers,
  removeMember,
  revokeBusinessInvitation,
  searchInvitees,
  type MailSealing,
} from '@tipme/database';
import { z } from 'zod';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { signalBusiness } from './business-live.js';

const membersQuerySchema = z
  .object({ locationId: z.uuid().optional() })
  .strict();

/**
 * Lane B3: a manager's invitations (email, one-time link or TipMe username) and team. Each route
 * acts only within the caller's own business and scope; anything else answers as not found.
 */
@Controller('v1/me/businesses')
@UseGuards(BusinessEnabledGuard, SessionGuard, CsrfGuard)
export class BusinessMembersController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    // Optional: integration tests may build this controller without the live module.
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  /** The link of a link invitation is in this answer only: just its hash is kept. */
  @Post(':id/invitations')
  @HttpCode(201)
  @RateLimit('handles')
  @Header('Cache-Control', 'private, no-store')
  async invite(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Body(new ZodValidationPipe(invitationRequestSchema))
    body: InvitationRequest,
  ): Promise<ApiDataResponse<InvitationCreated>> {
    const data = await inviteToBusiness(
      this.database.db,
      this.sealing,
      auth.userId,
      businessId,
      body,
    );
    signalBusiness(this.database.db, this.publishLive, { businessId });
    return { data };
  }

  @Get(':id/invitations')
  @Header('Cache-Control', 'private, no-store')
  async invitations(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
  ): Promise<ApiDataResponse<InvitationRow[]>> {
    return {
      data: await listBusinessInvitations(
        this.database.db,
        auth.userId,
        businessId,
      ),
    };
  }

  @Post(':id/invitations/:invitationId/revoke')
  @HttpCode(204)
  async revoke(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Param('invitationId') invitationId: string,
  ): Promise<void> {
    await revokeBusinessInvitation(
      this.database.db,
      auth.userId,
      businessId,
      invitationId,
    );
    signalBusiness(this.database.db, this.publishLive, { businessId });
  }

  /** A username's public card only (display name, handle, photo): never contact details. */
  @Get(':id/invitees')
  @RateLimit('handles')
  @Header('Cache-Control', 'private, no-store')
  async invitees(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Query(new ZodValidationPipe(inviteeQuerySchema)) query: { q: string },
  ): Promise<ApiDataResponse<InviteeCard[]>> {
    return {
      data: await searchInvitees(
        this.database.db,
        auth.userId,
        businessId,
        query.q,
      ),
    };
  }

  @Get(':id/members')
  @Header('Cache-Control', 'private, no-store')
  async members(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Query(new ZodValidationPipe(membersQuerySchema))
    query: { locationId?: string },
  ): Promise<ApiDataResponse<MemberRow[]>> {
    return {
      data: await listMembers(
        this.database.db,
        auth.userId,
        businessId,
        query.locationId,
      ),
    };
  }

  @Post(':id/members/:memberId/remove')
  @HttpCode(204)
  async remove(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Param('memberId') memberId: string,
  ): Promise<void> {
    await removeMember(this.database.db, auth.userId, businessId, memberId);
    signalBusiness(this.database.db, this.publishLive, { memberId });
  }
}
