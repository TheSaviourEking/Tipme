import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  Inject,
  NotFoundException,
  Optional,
  Param,
  HttpCode,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Logger } from '@tipme/observability';
import type { Response } from 'express';
import {
  messageReportSchema,
  myTipsNoteSchema,
  myWithdrawalsQuerySchema,
  withdrawalRequestSchema,
  type ActivityRow,
  ApiDataResponse,
  type DashboardSummary,
  type MyTipDetail,
  type MyTipRow,
  type TipTotals,
  type WeeklyReportData,
  type WithdrawalQuoteLocalResponse,
  type WithdrawalQuoteResponse,
  withdrawalQuoteQuerySchema,
  type WithdrawalsPage,
} from '@tipme/contracts';
import {
  dashboardSummary,
  exportMyTipsCsv,
  getWeeklyReport,
  listMyTips,
  listMyWithdrawals,
  listWeeklyReports,
  localWithdrawalQuote,
  myProfileId,
  hideMessage,
  myTipDetail,
  myTipTotals,
  recentActivity,
  reportMessage,
  requestWithdrawal,
  safeError,
  withdrawalInReview,
  withdrawalQuote,
  withdrawalsAvailable,
  type PayoutReader,
} from '@tipme/database';
import { z } from 'zod';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { WITHDRAWAL_PROVIDER_TOKEN } from '../checkout/payment-provider.provider.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ServerEvents } from '../analytics/server-events.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import {
  PARTNER_QUOTE_CACHE,
  type RedisPartnerQuoteCache,
} from '../infra/partner-quote-cache.js';
import { LOGGER } from '../tokens.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';

const idempotencyKeyPipe = new ZodValidationPipe(z.uuid());

/** The signed-in recipient's own money and tips; another recipient's data is never reachable. */
@Controller('v1/me')
@UseGuards(SessionGuard, CsrfGuard)
export class DashboardController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(WITHDRAWAL_PROVIDER_TOKEN) private readonly provider: PayoutReader,
    @Inject(ServerEvents) private readonly events: ServerEvents,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(PARTNER_QUOTE_CACHE)
    private readonly partnerCache: RedisPartnerQuoteCache,
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  /** A wrong key looks like an outage to the recipient; this is how staff tell them apart. */
  private logReadFailure(during: 'quote' | 'request') {
    return (failure: ReturnType<typeof safeError>) =>
      this.logger.warn({
        event: 'withdrawal.provider_read_failed',
        during,
        provider: this.provider.name,
        ...failure,
      });
  }

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

  @Get('tips')
  @Header('Cache-Control', 'private, no-store')
  async tips(
    @CurrentUser() auth: AuthContext,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('note') note?: string,
  ): Promise<
    ApiDataResponse<{ items: MyTipRow[]; nextCursor: string | null }>
  > {
    if (q !== undefined && (typeof q !== 'string' || q.length > 100))
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    // Absent means no filter; anything but "with" is refused rather than ignored.
    const noteFilter =
      note === undefined ? undefined : myTipsNoteSchema.safeParse(note);
    if (noteFilter && !noteFilter.success)
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    return {
      data: await listMyTips(this.database.db, await this.profile(auth), {
        status: status === 'paid' || status === 'confirming' ? status : 'all',
        ...(cursor ? { cursor: cursor.slice(0, 200) } : {}),
        limit: Number.parseInt(limit ?? '20', 10) || 20,
        ...(q ? { q } : {}),
        ...(noteFilter?.success ? { note: noteFilter.data } : {}),
      }),
    };
  }

  /** What the recipient has received from paid tips. Tips still being confirmed are not counted. */
  @Get('tip-totals')
  @Header('Cache-Control', 'private, no-store')
  async tipTotals(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<TipTotals>> {
    return {
      data: await myTipTotals(this.database.db, await this.profile(auth)),
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

  /** What can be withdrawn now, from both TipMe's ledger and the payment provider's balance. */
  @Get('withdrawal-quote')
  @Header('Cache-Control', 'private, no-store')
  async quoteWithdrawal(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(withdrawalQuoteQuerySchema))
    query: z.infer<typeof withdrawalQuoteQuerySchema>,
  ): Promise<
    ApiDataResponse<WithdrawalQuoteResponse | WithdrawalQuoteLocalResponse>
  > {
    const profileId = await this.profile(auth);
    // A live update's re-read: TipMe's records only, never the payment partner or its cache.
    if (query.scope === 'local') {
      const [local, inReview] = await Promise.all([
        localWithdrawalQuote(this.database.db, {
          profileId,
          provider: this.provider,
        }),
        withdrawalInReview(this.database.db, profileId),
      ]);
      return { data: { ...local, inReview } };
    }
    const [quote, inReview] = await Promise.all([
      withdrawalQuote(this.database.db, {
        profileId,
        provider: this.provider,
        onReadFailure: this.logReadFailure('quote'),
        // Only the provider's side, briefly; TipMe's ledger is read fresh on every quote.
        cache: this.partnerCache,
      }),
      withdrawalInReview(this.database.db, profileId),
    ]);
    return {
      data:
        quote.state === 'ready'
          ? {
              ...quote,
              inReview,
              withdrawableMinor: quote.withdrawableMinor.toString(),
              ledgerMinor: quote.ledgerMinor.toString(),
              providerMinor: quote.providerMinor.toString(),
              feeMinor: quote.feeMinor.toString(),
            }
          : { ...quote, inReview },
    };
  }

  /** The recipient's withdrawals, newest request first, each with the bank it went to. */
  @Get('withdrawals')
  @Header('Cache-Control', 'private, no-store')
  async withdrawals(
    @CurrentUser() auth: AuthContext,
    @Query(new ZodValidationPipe(myWithdrawalsQuerySchema))
    query: z.infer<typeof myWithdrawalsQuerySchema>,
  ): Promise<ApiDataResponse<WithdrawalsPage>> {
    return {
      data: await listMyWithdrawals(
        this.database.db,
        await this.profile(auth),
        query,
      ),
    };
  }

  /**
   * A withdrawal of any amount up to what can be withdrawn. It is recorded and queued here; the
   * worker starts the payout, and the provider's answer records the outcome.
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
    // Before and after: the request itself always asks the provider (it takes no cache), and a
    // quote shown meanwhile or next must too. A failed invalidation is covered by the stamp of
    // TipMe's records in every key, which the new payout changes.
    const scope = { provider: this.provider.name, profileId };
    await this.partnerCache.invalidate(scope);
    let result: Awaited<ReturnType<typeof requestWithdrawal>>;
    try {
      result = await requestWithdrawal(this.database.db, {
        profileId,
        amountMinor: BigInt(body.amountMinor),
        idempotencyKey: key,
        provider: this.provider,
        onReadFailure: this.logReadFailure('request'),
      });
    } finally {
      await this.partnerCache.invalidate(scope);
    }
    // The request committed: the person's other open tabs show it (this tab reloads itself).
    void this.publishLive({
      to: { profile: profileId },
      type: 'withdrawals.changed',
    });
    await this.events.record(
      'payout_requested',
      `payout_requested.${result.payoutId}`,
      profileId,
    );
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
