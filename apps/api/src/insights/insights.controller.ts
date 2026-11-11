import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Module,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  campaignCreateSchema,
  campaignRenameSchema,
  earningsPeriodQuerySchema,
  earningsTrendQuerySchema,
  supportRequestSchema,
  SUPPORT_PRO_LINE,
  type ApiDataResponse,
  type CampaignCreateRequest,
  type CampaignDetail,
  type CampaignList,
  type CampaignRenameRequest,
  type CampaignRow,
  type EarningsPeriodQuery,
  type EarningsPeriodView,
  type EarningsSummary,
  type EarningsTrend,
  type EarningsTrendQuery,
  type MonthlyRecapData,
  type MonthlyRecapListItem,
  type MySupportRequest,
  type SupportRequestInput,
} from '@tipme/contracts';
import {
  campaignDetail,
  createCampaign,
  earningsPeriod,
  earningsSummary,
  earningsTrend,
  getMonthlyRecap,
  listCampaigns,
  listMonthlyRecaps,
  listMySupportRequests,
  myPagePlan,
  renameCampaign,
  sendSupportRequest,
  stopCampaign,
} from '@tipme/database';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';

/**
 * Pro insights (11 Nov 2026): earnings analytics, Campaign Studio, the monthly recap and support.
 * The signed-in person's own page only. Pro is read from `profiles.plan` on every request (a paid
 * month or a staff grant, ruling 4), so a lapse falls back at once and nothing is deleted.
 */
@Controller('v1/me')
@UseGuards(SessionGuard, CsrfGuard)
export class InsightsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  private async page(auth: AuthContext) {
    const page = await myPagePlan(this.database.db, auth.userId);
    if (!page) throw new CodedHttpException(404, 'NOT_FOUND');
    return page;
  }

  /** The basics, Free and Pro alike. */
  @Get('earnings')
  @Header('Cache-Control', 'private, no-store')
  async summary(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<EarningsSummary>> {
    const { profileId } = await this.page(auth);
    return {
      data: await earningsSummary(this.database.db, profileId, new Date()),
    };
  }

  /** One week, month or year: average, best day, change and notes (Pro). */
  @Get('earnings/period')
  @Header('Cache-Control', 'private, no-store')
  async period(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(earningsPeriodQuerySchema))
    query: EarningsPeriodQuery,
  ): Promise<ApiDataResponse<EarningsPeriodView>> {
    const { profileId, pro } = await this.page(auth);
    if (!pro) throw new CodedHttpException(403, 'EARNINGS_PRO_REQUIRED');
    const view = await earningsPeriod(this.database.db, profileId, {
      period: query.period,
      ...(query.at ? { at: query.at } : {}),
      now: new Date(),
    });
    if (!view) throw new CodedHttpException(400, 'VALIDATION_FAILED');
    return { data: view };
  }

  /** The last 12 weeks or months (Pro). */
  @Get('earnings/trend')
  @Header('Cache-Control', 'private, no-store')
  async trend(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(earningsTrendQuerySchema))
    query: EarningsTrendQuery,
  ): Promise<ApiDataResponse<EarningsTrend>> {
    const { profileId, pro } = await this.page(auth);
    if (!pro) throw new CodedHttpException(403, 'EARNINGS_PRO_REQUIRED');
    return {
      data: await earningsTrend(this.database.db, profileId, {
        unit: query.unit,
        now: new Date(),
      }),
    };
  }

  /** Campaigns, Free (1 running) and Pro (20 running) alike. */
  @Get('campaigns')
  @Header('Cache-Control', 'private, no-store')
  async campaigns(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<CampaignList>> {
    const { profileId } = await this.page(auth);
    return { data: await listCampaigns(this.database.db, profileId) };
  }

  @Post('campaigns')
  @HttpCode(201)
  async createCampaign(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(campaignCreateSchema))
    body: CampaignCreateRequest,
  ): Promise<ApiDataResponse<CampaignRow>> {
    const { profileId } = await this.page(auth);
    return {
      data: await createCampaign(this.database.db, profileId, body),
    };
  }

  @Get('campaigns/:id')
  @Header('Cache-Control', 'private, no-store')
  async campaign(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<CampaignDetail>> {
    const { profileId } = await this.page(auth);
    const detail = await campaignDetail(this.database.db, profileId, id);
    if (!detail) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: detail };
  }

  @Patch('campaigns/:id')
  @HttpCode(200)
  async rename(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(campaignRenameSchema))
    body: CampaignRenameRequest,
  ): Promise<ApiDataResponse<{ renamed: true }>> {
    const { profileId } = await this.page(auth);
    await renameCampaign(this.database.db, profileId, id, body.name);
    return { data: { renamed: true } };
  }

  /** Stopping keeps the results; the link keeps opening the page. */
  @Post('campaigns/:id/stop')
  @HttpCode(200)
  async stop(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<{ stopped: true }>> {
    const { profileId } = await this.page(auth);
    await stopCampaign(this.database.db, profileId, id);
    return { data: { stopped: true } };
  }

  /** The page's monthly recaps (Pro); a lapse hides them and keeps them. */
  @Get('recaps')
  @Header('Cache-Control', 'private, no-store')
  async recaps(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MonthlyRecapListItem[]>> {
    const { profileId, pro } = await this.page(auth);
    if (!pro) throw new CodedHttpException(403, 'RECAP_PRO_REQUIRED');
    return { data: await listMonthlyRecaps(this.database.db, profileId) };
  }

  @Get('recaps/:month')
  @Header('Cache-Control', 'private, no-store')
  async recap(
    @CurrentUser() auth: AuthContext,
    @Param('month') month: string,
  ): Promise<ApiDataResponse<MonthlyRecapData>> {
    const { profileId, pro } = await this.page(auth);
    if (!pro) throw new CodedHttpException(403, 'RECAP_PRO_REQUIRED');
    const recap = await getMonthlyRecap(this.database.db, profileId, month);
    if (!recap) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: recap };
  }

  /** Sends a support request to TipMe's staff queue. */
  @Post('support')
  @HttpCode(201)
  async support(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(supportRequestSchema))
    body: SupportRequestInput,
  ): Promise<ApiDataResponse<{ id: string; priority: boolean }>> {
    return {
      data: await sendSupportRequest(this.database.db, {
        userId: auth.userId,
        topic: body.topic,
        body: body.body,
      }),
    };
  }

  /** The person's requests (no words, only topic, date and state) and what Pro means for them. */
  @Get('support')
  @Header('Cache-Control', 'private, no-store')
  async mySupport(@CurrentUser() auth: AuthContext): Promise<
    ApiDataResponse<{
      requests: MySupportRequest[];
      /** "Pro requests are answered first." for a Pro page; null otherwise. No time is promised. */
      proLine: string | null;
    }>
  > {
    const page = await myPagePlan(this.database.db, auth.userId);
    return {
      data: {
        requests: await listMySupportRequests(this.database.db, auth.userId),
        proLine: page?.pro ? SUPPORT_PRO_LINE : null,
      },
    };
  }
}

@Module({
  controllers: [InsightsController],
  providers: [SessionGuard, CsrfGuard],
})
export class InsightsModule {}
