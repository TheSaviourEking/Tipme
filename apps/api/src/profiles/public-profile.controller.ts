import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
} from '@nestjs/common';
import type {
  ApiDataResponse,
  HandleStatus,
  PublicProfile,
} from '@tipme/contracts';
import { checkHandle, normaliseHandle, publicProfile } from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { DatabaseProvider } from '../infra/database.js';

@Controller('v1')
export class PublicProfileController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  /** A live page's public details. Not live, deleted and unknown pages are all 404. */
  @Get('profiles/:handle')
  @Header('Cache-Control', 'no-store')
  async profile(
    @Param('handle') handle: string,
  ): Promise<ApiDataResponse<PublicProfile>> {
    const page = await publicProfile(this.database.db, handle);
    if (!page) throw new NotFoundException();
    return { data: page };
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
