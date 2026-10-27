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
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  messageReportSchema,
  withdrawalRequestSchema,
  type ActivityRow,
  ApiDataResponse,
  type DashboardSummary,
  type VisitsToday,
  type MyTipDetail,
  type MyTipRow,
  type WeeklyReportData,
} from '@tipme/contracts';
import {
  dashboardSummary,
  exportMyTipsCsv,
  getWeeklyReport,
  listMyTips,
  listWeeklyReports,
  myProfileId,
  hideMessage,
  myTipDetail,
  recentActivity,
  reportMessage,
  requestWithdrawal,
  visitsToday,
  withdrawalsAvailable,
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
import { CodedHttpException } from '../http/coded.exception.js';
import { ServerEvents } from '../analytics/server-events.js';
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
    @Inject(ServerEvents) private readonly events: ServerEvents,
  ) {}

  private profile(auth: AuthContext): Promise<string> {
    return myProfileId(this.database.db, auth.userId);
  }

  @Get('dashboard')
  @Header('Cache-Control', 'private, no-store')
  async summary(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<DashboardSummary>> {
    const profileId = await this.profile(auth);
    const [summary, available] = await Promise.all([
      dashboardSummary(this.database.db, profileId, new Date()),
      withdrawalsAvailable(this.database.db, {
        profileId,
        provider: this.provider.name,
      }),
    ]);
    return { data: { ...summary, withdrawalsAvailable: available } };
  }

  /** For "your page was opened N times today" while supporters can't tip yet. */
  @Get('visits-today')
  @Header('Cache-Control', 'private, no-store')
  async visits(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<VisitsToday>> {
    if (!this.events.enabled) return { data: { visits: null } };
    return {
      data: {
        visits: await visitsToday(this.database.db, {
          profileId: await this.profile(auth),
        }),
      },
    };
  }

  @Get('tips')
  @Header('Cache-Control', 'private, no-store')
  async tips(
    @CurrentUser() auth: AuthContext,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
  ): Promise<
    ApiDataResponse<{ items: MyTipRow[]; nextCursor: string | null }>
  > {
    if (q !== undefined && (typeof q !== 'string' || q.length > 100))
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    return {
      data: await listMyTips(this.database.db, await this.profile(auth), {
        status: status === 'paid' || status === 'confirming' ? status : 'all',
        ...(cursor ? { cursor: cursor.slice(0, 200) } : {}),
        limit: Number.parseInt(limit ?? '20', 10) || 20,
        ...(q ? { q } : {}),
      }),
    };
  }

  /** The recipient's own tips as CSV (amounts and status only; never messages). */
  @Get('exports/tips.csv')
  @Header('Cache-Control', 'private, no-store')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  async exportTips(
    @CurrentUser() auth: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const { csv } = await exportMyTipsCsv(
      this.database.db,
      await this.profile(auth),
    );
    const day = new Date(Date.now() + 3_600_000).toISOString().slice(0, 10);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="tipme-tips-${day}.csv"`,
    );
    // A byte-order mark so spreadsheet apps read the naira sign and names as UTF-8.
    return `\ufeff${csv}`;
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
    const profileId = await this.profile(auth);
    const result = await requestWithdrawal(this.database.db, {
      profileId,
      amountMinor: BigInt(body.amountMinor),
      idempotencyKey: key,
      provider: this.provider,
    });
    await this.events.record(
      'payout_requested',
      `payout_requested.${result.payoutId}`,
      profileId,
    );
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
