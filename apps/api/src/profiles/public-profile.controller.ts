import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  ApiDataResponse,
  HandleStatus,
  PublicProfile,
} from '@tipme/contracts';
import {
  checkHandle,
  handleAliasTarget,
  normaliseHandle,
  publicProfile,
} from '@tipme/database';
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
