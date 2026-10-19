import {
  Body,
  Controller,
  Get,
  Header,
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
} from '@tipme/database';
import { z } from 'zod';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';

/**
 * What the pretend messenger and mailbox "sent", newest first, so codes and links can be used
 * locally and in tests. Registered only with MESSAGING_PROVIDER=mock (refused in production).
 */
@Controller('v1/dev/inbox')
export class PretendInboxController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  async inbox(): Promise<ApiDataResponse<PretendMessage[]>> {
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

/** Development only: run scheduled jobs now instead of waiting for Monday morning. */
@Controller('v1/dev/jobs')
export class DevJobsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Post('weekly-report')
  @HttpCode(200)
  async weekly(
    @Body(new ZodValidationPipe(weekSchema)) body: z.infer<typeof weekSchema>,
  ): Promise<ApiDataResponse<{ isoWeek: string; created: number }>> {
    const isoWeek = body.isoWeek ?? previousIsoWeek(new Date());
    const { created } = await runWeeklyReports(this.database.db, {
      isoWeek,
      ...(body.handle ? { onlyHandle: body.handle } : {}),
    });
    return { data: { isoWeek, created } };
  }
}

@Module({ controllers: [PretendInboxController, DevJobsController] })
export class PretendInboxModule {}
