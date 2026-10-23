import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  NotFoundException,
  Param,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  messageReportSchema,
  withdrawalRequestSchema,
  type ActivityRow,
  ApiDataResponse,
  type DashboardSummary,
  type MyTipDetail,
  type MyTipRow,
  type WeeklyReportData,
} from '@tipme/contracts';
import {
  dashboardSummary,
  getWeeklyReport,
  listMyTips,
  listWeeklyReports,
  myProfileId,
  hideMessage,
  myTipDetail,
  recentActivity,
  reportMessage,
  requestWithdrawal,
} from '@tipme/database';
import type { MockProvider } from '@tipme/payments';
import { z } from 'zod';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { PAYMENT_PROVIDER_TOKEN } from '../checkout/payment-provider.provider.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';

const idempotencyKeyPipe = new ZodValidationPipe(z.uuid());

/** The signed-in recipient's own money and tips; another recipient's data is never reachable. */
@Controller('v1/me')
@UseGuards(SessionGuard, CsrfGuard)
export class DashboardController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(PAYMENT_PROVIDER_TOKEN) private readonly provider: MockProvider,
  ) {}

  private profile(auth: AuthContext): Promise<string> {
    return myProfileId(this.database.db, auth.userId);
  }

  @Get('dashboard')
  @Header('Cache-Control', 'private, no-store')
  async summary(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<DashboardSummary>> {
    return {
      data: await dashboardSummary(
        this.database.db,
        await this.profile(auth),
        new Date(),
      ),
    };
  }

  @Get('tips')
  @Header('Cache-Control', 'private, no-store')
  async tips(
    @CurrentUser() auth: AuthContext,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ): Promise<
    ApiDataResponse<{ items: MyTipRow[]; nextCursor: string | null }>
  > {
    return {
      data: await listMyTips(this.database.db, await this.profile(auth), {
        status: status === 'paid' || status === 'confirming' ? status : 'all',
        ...(cursor ? { cursor: cursor.slice(0, 200) } : {}),
        limit: Number.parseInt(limit ?? '20', 10) || 20,
      }),
    };
  }

  @Get('tips/:tipId')
  @Header('Cache-Control', 'private, no-store')
  async tip(
    @CurrentUser() auth: AuthContext,
    @Param('tipId') tipId: string,
  ): Promise<ApiDataResponse<MyTipDetail>> {
    const detail = await myTipDetail(
      this.database.db,
      await this.profile(auth),
      tipId,
    );
    if (!detail) throw new NotFoundException();
    return { data: detail };
  }

  /** Hide a supporter's message from your own views (PR-011). */
  @Post('tips/:tipId/message/hide')
  @HttpCode(200)
  async hideMessage(
    @CurrentUser() auth: AuthContext,
    @Param('tipId') tipId: string,
  ): Promise<ApiDataResponse<{ hidden: true }>> {
    await hideMessage(this.database.db, {
      profileId: await this.profile(auth),
      tipId,
    });
    return { data: { hidden: true } };
  }

  /** Report a supporter's message to TipMe (it is also hidden from you). */
  @Post('tips/:tipId/message/report')
  @HttpCode(200)
  async reportMessage(
    @CurrentUser() auth: AuthContext,
    @Param('tipId') tipId: string,
    @Body(new ZodValidationPipe(messageReportSchema))
    body: z.infer<typeof messageReportSchema>,
  ): Promise<ApiDataResponse<{ reported: true }>> {
    await reportMessage(this.database.db, {
      profileId: await this.profile(auth),
      tipId,
      reason: body.reason,
    });
    return { data: { reported: true } };
  }

  @Get('activity')
  @Header('Cache-Control', 'private, no-store')
  async activity(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<ActivityRow[]>> {
    return {
      data: await recentActivity(
        this.database.db,
        await this.profile(auth),
        10,
      ),
    };
  }

  /**
   * A pretend withdrawal of any amount up to the available balance. With the mock provider the
   * pretend bank pays at once; the worker's payout reconciliation then records it as paid.
   */
  @Post('withdrawals')
  async withdraw(
    @CurrentUser() auth: AuthContext,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(withdrawalRequestSchema))
    body: z.infer<typeof withdrawalRequestSchema>,
  ): Promise<ApiDataResponse<{ payoutId: string; status: string }>> {
    const key = idempotencyKeyPipe.transform(idempotencyKey, {
      type: 'custom',
      data: 'idempotency-key',
    });
    const result = await requestWithdrawal(this.database.db, {
      profileId: await this.profile(auth),
      amountMinor: BigInt(body.amountMinor),
      idempotencyKey: key,
      provider: this.provider,
    });
    if (result.providerReference)
      await this.provider.settlePayout(result.providerReference);
    return { data: { payoutId: result.payoutId, status: result.status } };
  }

  @Get('reports')
  @Header('Cache-Control', 'private, no-store')
  async reports(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<{ week: string; data: WeeklyReportData }[]>> {
    return {
      data: await listWeeklyReports(this.database.db, await this.profile(auth)),
    };
  }

  @Get('reports/:week')
  @Header('Cache-Control', 'private, no-store')
  async report(
    @CurrentUser() auth: AuthContext,
    @Param('week') week: string,
  ): Promise<ApiDataResponse<WeeklyReportData>> {
    const report = await getWeeklyReport(
      this.database.db,
      await this.profile(auth),
      week,
    );
    if (!report) throw new NotFoundException();
    return { data: report };
  }
}
