import {
  Controller,
  Get,
  Headers,
  Inject,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { ApiDataResponse, TipStatusView } from '@tipme/contracts';
import { tipStatusView } from '@tipme/database';
import type { Response } from 'express';
import { z } from 'zod';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { verifyStatusToken } from './status-token.js';

const tipIdSchema = z.uuid();

/**
 * A supporter's receipt. Readable only with the tip's status token; a wrong or missing token is
 * indistinguishable from an unknown tip (404), so it reveals nothing.
 */
@Controller('v1/tips')
export class StatusController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get(':tipId/status')
  async status(
    @Param('tipId') tipId: string,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<TipStatusView>> {
    response.setHeader('Cache-Control', 'private, no-store');
    const token = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(
      authorization ?? '',
    )?.[1];
    if (
      !token ||
      !tipIdSchema.safeParse(tipId).success ||
      !verifyStatusToken(this.config.STATUS_TOKEN_SECRET, tipId, token)
    )
      throw new NotFoundException();
    const view = await tipStatusView(this.database.db, tipId, new Date());
    if (!view) throw new NotFoundException();
    return { data: view };
  }
}
