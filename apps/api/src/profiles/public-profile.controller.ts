import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Inject,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  profileReportSchema,
  type ApiDataResponse,
  type HandleStatus,
  type ProfileReportReason,
  type PublicProfile,
} from '@tipme/contracts';
import {
  checkHandle,
  handleAliasTarget,
  normaliseHandle,
  publicProfile,
  reportProfile,
} from '@tipme/database';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { DatabaseProvider } from '../infra/database.js';

@Controller('v1')
export class PublicProfileController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  /**
   * A live page's public details. Not live, deleted and unknown pages are all 404. An old handle
   * of a live page (PR-011) answers 308 with the current one, so the web can redirect to it.
   */
  @Get('profiles/:handle')
  @Header('Cache-Control', 'no-store')
  async profile(
    @Param('handle') handle: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<PublicProfile | { movedTo: string }>> {
    const page = await publicProfile(this.database.db, handle);
    if (page) return { data: page };
    const movedTo = await handleAliasTarget(this.database.db, handle);
    if (!movedTo) throw new NotFoundException();
    response.status(308).setHeader('Location', `/v1/profiles/${movedTo}`);
    return { data: { movedTo } };
  }

  /**
   * Reporting a page (PR-013): impersonation, a scam, abuse or other. Always 202, whether or
   * not such a page exists, so the answer reveals nothing. Rate-limited per address.
   */
  @Post('profiles/:handle/report')
  @HttpCode(202)
  @RateLimit('reports')
  async report(
    @Param('handle') handle: string,
    @Body(new ZodValidationPipe(profileReportSchema))
    body: { reason: ProfileReportReason },
  ): Promise<ApiDataResponse<{ accepted: true }>> {
    await reportProfile(this.database.db, { handle, reason: body.reason });
    return { data: { accepted: true } };
  }

  @Get('handles/:handle/availability')
  @RateLimit('handles')
  @Header('Cache-Control', 'no-store')
  async availability(
    @Param('handle') handle: string,
  ): Promise<ApiDataResponse<{ handle: string | null; status: HandleStatus }>> {
    return {
      data: {
        handle: normaliseHandle(handle),
        status: await checkHandle(this.database.db, handle, new Date()),
      },
    };
  }
}
