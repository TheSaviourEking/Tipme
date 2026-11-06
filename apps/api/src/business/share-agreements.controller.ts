import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  shareCounterSchema,
  shareProposalSchema,
  shareReportSchema,
  type ApiDataResponse,
  type BusinessShareRow,
  type ShareAgreementView,
  type ShareCounter,
  type ShareProposal,
  type ShareReport,
} from '@tipme/contracts';
import {
  acceptShare,
  answerSuggestedShare,
  counterShare,
  declineShare,
  listBusinessShares,
  myShares,
  proposeShare,
  reportBusiness,
  type MailSealing,
} from '@tipme/database';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { SharesEnabledGuard } from './release2-flags.guard.js';

/**
 * Lane R2-C1: the share agreement. A business (an owner, or the manager of that location) proposes
 * a split; the staff member accepts, declines or suggests another on their Work page; they can
 * report the business to TipMe. Off (404) unless BUSINESS_ENABLED and BUSINESS_SHARES_ENABLED.
 * The business never learns how the staff member answered its own proposal before the start date
 * (see the operations file); a report never reaches the business.
 */
@Controller('v1/me')
@UseGuards(BusinessEnabledGuard, SharesEnabledGuard, SessionGuard, CsrfGuard)
export class ShareAgreementsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
  ) {}

  @Get('businesses/:id/shares')
  @Header('Cache-Control', 'private, no-store')
  async list(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
  ): Promise<ApiDataResponse<BusinessShareRow[]>> {
    return {
      data: await listBusinessShares(this.database.db, auth.userId, businessId),
    };
  }

  @Post('businesses/:id/shares')
  @HttpCode(201)
  async propose(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Body(new ZodValidationPipe(shareProposalSchema)) body: ShareProposal,
  ): Promise<ApiDataResponse<BusinessShareRow>> {
    return {
      data: await proposeShare(
        this.database.db,
        this.sealing,
        auth.userId,
        businessId,
        body,
      ),
    };
  }

  /** The business accepts a split the staff member suggested. */
  @Post('businesses/:id/shares/:agreementId/accept')
  @HttpCode(200)
  async businessAccept(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Param('agreementId') agreementId: string,
  ): Promise<ApiDataResponse<BusinessShareRow>> {
    return {
      data: await answerSuggestedShare(
        this.database.db,
        auth.userId,
        businessId,
        agreementId,
        'accept',
      ),
    };
  }

  /** The business declines a split the staff member suggested; today's split stays. */
  @Post('businesses/:id/shares/:agreementId/decline')
  @HttpCode(200)
  async businessDecline(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Param('agreementId') agreementId: string,
  ): Promise<ApiDataResponse<BusinessShareRow>> {
    return {
      data: await answerSuggestedShare(
        this.database.db,
        auth.userId,
        businessId,
        agreementId,
        'decline',
      ),
    };
  }

  @Get('work/shares')
  @Header('Cache-Control', 'private, no-store')
  async mine(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<ShareAgreementView[]>> {
    return { data: await myShares(this.database.db, auth.userId) };
  }

  @Post('work/shares/:agreementId/accept')
  @HttpCode(200)
  async accept(
    @CurrentUser() auth: AuthContext,
    @Param('agreementId') agreementId: string,
  ): Promise<ApiDataResponse<ShareAgreementView>> {
    return {
      data: await acceptShare(this.database.db, auth.userId, agreementId),
    };
  }

  @Post('work/shares/:agreementId/decline')
  @HttpCode(204)
  async decline(
    @CurrentUser() auth: AuthContext,
    @Param('agreementId') agreementId: string,
  ): Promise<void> {
    await declineShare(this.database.db, auth.userId, agreementId);
  }

  @Post('work/shares/:agreementId/counter')
  @HttpCode(201)
  async counter(
    @CurrentUser() auth: AuthContext,
    @Param('agreementId') agreementId: string,
    @Body(new ZodValidationPipe(shareCounterSchema)) body: ShareCounter,
  ): Promise<ApiDataResponse<ShareAgreementView>> {
    return {
      data: await counterShare(
        this.database.db,
        auth.userId,
        agreementId,
        body,
      ),
    };
  }

  @Post('work/:memberId/report-business')
  @HttpCode(204)
  async report(
    @CurrentUser() auth: AuthContext,
    @Param('memberId') memberId: string,
    @Body(new ZodValidationPipe(shareReportSchema)) body: ShareReport,
  ): Promise<void> {
    await reportBusiness(this.database.db, auth.userId, memberId, body);
  }
}
