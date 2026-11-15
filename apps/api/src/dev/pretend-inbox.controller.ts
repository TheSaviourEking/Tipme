import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Module,
  Post,
} from '@nestjs/common';
import type { ApiDataResponse, PretendMessage } from '@tipme/contracts';
import {
  listPretendOutbox,
  previousIsoWeek,
  runWeeklyReports,
  mailSealing,
} from '@tipme/database';
import { z } from 'zod';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { bearerMatches } from '../http/bearer.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';

function authorisePreviewDevRoute(
  config: ApiConfig,
  authorization: string | undefined,
): void {
  if (
    config.DEPLOYMENT_MODE === 'preview' &&
    !bearerMatches(authorization, config.RELEASE_CHECK_TOKEN)
  )
    throw new CodedHttpException(404, 'NOT_FOUND');
}

/**
 * What the pretend messenger and mailbox "sent", newest first, so codes and links can be used
 * locally and in tests. Registered only with MAIL_DEFAULT_PROVIDER=mock (refused in production).
 * On a preview copy (staging) everyone with the shared preview password could read every
 * sign-in code, so there it also needs the release token; anyone else gets 404.
 */
@Controller('v1/dev/inbox')
export class PretendInboxController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async inbox(
    @Headers('authorization') authorization: string | undefined,
  ): Promise<ApiDataResponse<PretendMessage[]>> {
    authorisePreviewDevRoute(this.config, authorization);
    const rows = await listPretendOutbox(this.database.db, { limit: 30 });
    return {
      data: rows.map((row) => ({
        id: row.id,
        channel: row.channel as PretendMessage['channel'],
        to: row.recipientHint,
        subject: row.subject,
        body: row.body,
        sentAt: row.createdAt.toISOString(),
      })),
    };
  }
}

const weekSchema = z
  .object({
    isoWeek: z
      .string()
      .regex(/^\d{4}-W\d{2}$/)
      .optional(),
    // Only this recipient (keeps parallel tests apart).
    handle: z
      .string()
      .regex(/^[a-z0-9_]{3,30}$/)
      .optional(),
  })
  .strict();
const weeklyBody = new ZodValidationPipe(weekSchema);

/** Development only: run scheduled jobs now instead of waiting for Monday morning. */
@Controller('v1/dev/jobs')
export class DevJobsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Post('weekly-report')
  @HttpCode(200)
  async weekly(
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<ApiDataResponse<{ isoWeek: string; created: number }>> {
    authorisePreviewDevRoute(this.config, authorization);
    const parsed = weeklyBody.transform(body);
    const isoWeek = parsed.isoWeek ?? previousIsoWeek(new Date());
    const { created } = await runWeeklyReports(this.database.db, {
      sealing: mailSealing(Buffer.from(this.config.MAIL_SEAL_KEY, 'base64')),
      isoWeek,
      ...(parsed.handle ? { onlyHandle: parsed.handle } : {}),
    });
    return { data: { isoWeek, created } };
  }
}

@Module({ controllers: [PretendInboxController, DevJobsController] })
export class PretendInboxModule {}
