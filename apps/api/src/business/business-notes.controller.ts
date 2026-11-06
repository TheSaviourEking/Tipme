import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  businessNoteRequestSchema,
  noteReportSchema,
  type ApiDataResponse,
  type NoteReport,
  type WorkNoteView,
} from '@tipme/contracts';
import {
  memberNotes,
  reportNoteAsManager,
  reportNoteAsMember,
  writeBusinessNote,
} from '@tipme/database';
import { z } from 'zod';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { verifyStatusToken } from '../checkout/status-token.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import {
  ValidationFailedException,
  ZodValidationPipe,
} from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

const uuid = z.uuid();

/**
 * PR B5: the supporter's note about the person, after paying, and the member's and managers'
 * reports. The note is written with the receipt's status token only: no session, no cookie and
 * no CSRF (it is a cross-origin checkout route, `/v1/tips/`). It never touches the tip.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class BusinessNotesController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Post('tips/:tipId/business-note')
  @HttpCode(204)
  @RateLimit('business_note')
  @Header('Cache-Control', 'private, no-store')
  async write(
    @Param('tipId') tipId: string,
    @Headers('authorization') authorization: string | undefined,
    @Body() body: unknown,
  ): Promise<void> {
    // The token first, as on the receipt: a wrong one reads like an unknown tip, whatever the body.
    const token = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(
      authorization ?? '',
    )?.[1];
    if (
      !token ||
      !uuid.safeParse(tipId).success ||
      !verifyStatusToken(this.config.STATUS_TOKEN_SECRET, tipId, token)
    )
      throw new NotFoundException();
    const parsed = businessNoteRequestSchema.safeParse(body);
    if (!parsed.success)
      throw new ValidationFailedException([
        ...new Set(
          parsed.error.issues.map((issue) => issue.path.join('.') || '(body)'),
        ),
      ]);
    await writeBusinessNote(this.database.db, tipId, parsed.data);
  }

  @Get('me/work/notes')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'private, no-store')
  async mine(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<WorkNoteView[]>> {
    return { data: await memberNotes(this.database.db, auth.userId) };
  }

  @Post('me/work/notes/:tipId/report')
  @HttpCode(204)
  @UseGuards(SessionGuard, CsrfGuard)
  async reportAsMember(
    @CurrentUser() auth: AuthContext,
    @Param('tipId') tipId: string,
    @Body(new ZodValidationPipe(noteReportSchema)) body: NoteReport,
  ): Promise<void> {
    await reportNoteAsMember(this.database.db, {
      userId: auth.userId,
      tipId,
      reason: body.reason,
    });
  }

  @Post('me/businesses/:id/notes/:tipId/report')
  @HttpCode(204)
  @UseGuards(SessionGuard, CsrfGuard)
  async reportAsManager(
    @CurrentUser() auth: AuthContext,
    @Param('id') businessId: string,
    @Param('tipId') tipId: string,
    @Body(new ZodValidationPipe(noteReportSchema)) body: NoteReport,
  ): Promise<void> {
    await reportNoteAsManager(this.database.db, {
      userId: auth.userId,
      businessId,
      tipId,
      reason: body.reason,
    });
  }
}
