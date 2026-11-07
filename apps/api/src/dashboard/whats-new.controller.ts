import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  whatsNewSeenSchema,
  type ApiDataResponse,
  type WhatsNewList,
  type WhatsNewSeen,
  type WhatsNewStatus,
} from '@tipme/contracts';
import {
  listWhatsNew,
  markWhatsNewSeen,
  whatsNewStatus,
} from '@tipme/database';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';

/**
 * What's new for the signed-in recipient (changelog plan, Task 6.2): the approved updates that are
 * live in production, and when they last looked. Only approved user text is ever returned; never
 * the PR title or staff text.
 */
@Controller('v1/me/whats-new')
@UseGuards(SessionGuard, CsrfGuard)
export class WhatsNewController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  async list(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<WhatsNewList>> {
    return { data: await listWhatsNew(this.database.db, auth.userId) };
  }

  /** For the menu dot and the Home slip. */
  @Get('status')
  @Header('Cache-Control', 'private, no-store')
  async status(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<WhatsNewStatus>> {
    return { data: await whatsNewStatus(this.database.db, auth.userId) };
  }

  /** Seen up to `through` (the newest entry shown). Only moves forward, and never past now. */
  @Post('seen')
  @HttpCode(204)
  async seen(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(whatsNewSeenSchema)) body: WhatsNewSeen,
  ): Promise<void> {
    await markWhatsNewSeen(this.database.db, {
      userId: auth.userId,
      through: new Date(body.through),
    });
  }
}
