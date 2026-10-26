import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  profileReportSchema,
  type ApiDataResponse,
  type HandleStatus,
  type ProfileReportRequest,
  type PublicProfile,
} from '@tipme/contracts';
import {
  checkHandle,
  handleAliasTarget,
  normaliseHandle,
  avatarBytes,
  publicProfile,
  reportProfile,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';

@Controller('v1')
export class PublicProfileController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  /** A stored profile photo by id (`<uuid>.webp`); ids are random, bytes never change. */
  @Get('avatars/:file')
  async avatar(
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
    const id = /^([0-9a-f-]{36})\.webp$/.exec(file)?.[1];
    const bytes = id ? await avatarBytes(this.database.db, id) : null;
    if (!bytes) throw new NotFoundException();
    response
      .status(200)
      .setHeader('Content-Type', 'image/webp')
      .setHeader('X-Content-Type-Options', 'nosniff')
      .setHeader('Cache-Control', 'public, max-age=31536000, immutable')
      .send(bytes);
  }

  /**
   * Anyone reports a live page (impersonation, scam, abuse); it reaches the staff inbox. Pages
   * that aren't live answer 404 like unknown ones. Limited per client per hour.
   */
  @Post('profiles/:handle/report')
  @HttpCode(201)
  @RateLimit('reports')
  async report(
    @Param('handle') handle: string,
    @Body(new ZodValidationPipe(profileReportSchema))
    body: ProfileReportRequest,
  ): Promise<ApiDataResponse<{ reported: true }>> {
    return {
      data: await reportProfile(this.database.db, {
        handle: handle.slice(0, 40),
        reason: body.reason,
        ...(body.details ? { details: body.details } : {}),
      }),
    };
  }

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
