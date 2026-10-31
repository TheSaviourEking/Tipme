import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  opsMailExportQuerySchema,
  opsMailListQuerySchema,
  opsMailPeriodQuerySchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsMailContent,
  type OpsMailRow,
  type OpsMailSeriesPoint,
  type OpsMailSummary,
  type OpsMailTimelineEvent,
  type OpsReasonRequest,
} from '@tipme/contracts';
import {
  findAccountByHandleOrId,
  listMail,
  mailDailySeries,
  mailPeriodSummary,
  mailTimeline,
  openMailSnapshot,
  recordAudit,
  revealMailRecipient,
  type MailPeriod,
  type MailSealing,
} from '@tipme/database';
import type { Response } from 'express';
import { z } from 'zod';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE = 50;
const EXPORT_LIMIT = 250_000;

const periodOf = (query: {
  period: string;
  from?: string | undefined;
  to?: string | undefined;
}): MailPeriod =>
  query.period === 'range'
    ? { kind: 'range', from: query.from ?? '', to: query.to ?? '' }
    : ({ kind: query.period } as MailPeriod);

/** Quoted, and a leading formula character is neutralised so a spreadsheet won't execute it. */
function cell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}
const csv = (rows: (string | number | null)[][]) =>
  rows.map((row) => row.map(cell).join(',')).join('\n') + '\n';

/** Audit every email from inside TipMe. Never a body with a code, nor a link with its token. */
@Controller('v1/ops/email')
export class OpsEmailConsoleController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
  ) {}

  @Get('summary')
  @OpsPermission('issues.view')
  async summary(
    @Query(new ZodValidationPipe(opsMailPeriodQuerySchema))
    query: z.infer<typeof opsMailPeriodQuerySchema>,
  ): Promise<ApiDataResponse<OpsMailSummary>> {
    return {
      data: await mailPeriodSummary(
        this.database.db,
        periodOf(query),
        new Date(),
      ),
    };
  }

  @Get('series')
  @OpsPermission('issues.view')
  async series(
    @Query(new ZodValidationPipe(opsMailPeriodQuerySchema))
    query: z.infer<typeof opsMailPeriodQuerySchema>,
  ): Promise<ApiDataResponse<OpsMailSeriesPoint[]>> {
    return {
      data: await mailDailySeries(
        this.database.db,
        periodOf(query),
        new Date(),
      ),
    };
  }

  @Get('messages')
  @OpsPermission('issues.view')
  async messages(
    @Query(new ZodValidationPipe(opsMailListQuerySchema))
    query: z.infer<typeof opsMailListQuerySchema>,
  ): Promise<
    ApiDataResponse<{ rows: OpsMailRow[]; nextCursor: string | null }>
  > {
    const userId = query.account
      ? await findAccountByHandleOrId(this.database.db, query.account)
      : undefined;
    // An account that doesn't exist has no email.
    if (query.account && !userId)
      return { data: { rows: [], nextCursor: null } };
    return {
      data: await listMail(
        this.database.db,
        {
          period: periodOf(query),
          limit: PAGE,
          ...(query.type ? { type: query.type } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.provider ? { provider: query.provider } : {}),
          ...(userId ? { userId } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
        },
        new Date(),
      ),
    };
  }

  @Get('messages/:id/timeline')
  @OpsPermission('issues.view')
  async timeline(
    @Param('id') id: string,
  ): Promise<ApiDataResponse<OpsMailTimelineEvent[]>> {
    if (!UUID.test(id)) throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: await mailTimeline(this.database.db, id) };
  }

  /** The email as sent, with personal links removed. Security email is never shown. */
  @Get('messages/:id/content')
  @OpsPermission('issues.view')
  async content(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<OpsMailContent>> {
    if (!UUID.test(id)) throw new CodedHttpException(404, 'NOT_FOUND');
    const content = await openMailSnapshot(this.database.db, this.sealing, {
      messageId: id,
      staffUserId: ops.userId,
    });
    if (content.status === 'not_found')
      throw new CodedHttpException(404, 'NOT_FOUND');
    return { data: content };
  }

  @Post('messages/:id/reveal-recipient')
  @HttpCode(200)
  @OpsPermission('private.view')
  async revealRecipient(
    @CurrentOps() ops: OpsContext,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ address: string | null }>> {
    if (!UUID.test(id)) throw new CodedHttpException(404, 'NOT_FOUND');
    return {
      data: await revealMailRecipient(this.database.db, this.sealing, {
        messageId: id,
        staffUserId: ops.userId,
        reason: body.reason,
      }),
    };
  }

  @Get('export.csv')
  @OpsPermission('issues.view')
  async exportCsv(
    @CurrentOps() ops: OpsContext,
    @Query(new ZodValidationPipe(opsMailExportQuerySchema))
    query: z.infer<typeof opsMailExportQuerySchema>,
    @Res({ passthrough: true }) response: Pick<Response, 'setHeader'>,
  ): Promise<string> {
    const { db } = this.database;
    const period = periodOf(query);
    const now = new Date();
    await recordAudit(db, {
      staffUserId: ops.userId,
      action: 'email.exported',
      permission: 'issues.view',
      subjectType: 'mail_export',
      subjectId: query.kind,
    });
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="tipme-email-${query.kind}.csv"`,
    );
    if (query.kind === 'summary') {
      const summary = await mailPeriodSummary(db, period, now);
      return csv([
        ['measure', 'count', 'previous', 'change_pct'],
        ...Object.entries(summary.totals).map(([name, total]) => [
          name,
          total.count,
          total.previous,
          total.changePct,
        ]),
      ]);
    }
    const rows: (string | number | null)[][] = [
      [
        'created_at',
        'type',
        'category',
        'recipient',
        'account',
        'provider',
        'status',
        'last_event',
      ],
    ];
    const userId = query.account
      ? await findAccountByHandleOrId(db, query.account)
      : undefined;
    if (query.account && !userId) return csv(rows);
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<typeof listMail>> = await listMail(
        db,
        {
          period,
          limit: 1000,
          ...(query.type ? { type: query.type } : {}),
          ...(query.status ? { status: query.status } : {}),
          ...(query.provider ? { provider: query.provider } : {}),
          ...(userId ? { userId } : {}),
          ...(cursor ? { cursor } : {}),
        },
        now,
      );
      for (const row of page.rows)
        rows.push([
          row.createdAt,
          row.type,
          row.category,
          row.toHint,
          row.handle,
          row.provider,
          row.status,
          row.lastEvent,
        ]);
      cursor = page.nextCursor;
      // An audit file that silently stops is worse than none: ask for a narrower period.
      if (cursor && rows.length > EXPORT_LIMIT)
        throw new CodedHttpException(400, 'VALIDATION_FAILED');
    } while (cursor);
    return csv(rows);
  }
}
