import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import type { ApiDataResponse, TipStatusView } from '@tipme/contracts';
import { stopRecognition, tipStatusView } from '@tipme/database';
import type { Response } from 'express';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { ReceiptCheckService } from './receipt-check.service.js';
import { requireStatusToken } from './status-token.js';

/**
 * A supporter's receipt. Readable only with the tip's status token; a wrong or missing token is
 * indistinguishable from an unknown tip (404), so it reveals nothing.
 */
@Controller('v1/tips')
export class StatusController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ReceiptCheckService) private readonly receipt: ReceiptCheckService,
  ) {}

  @Get(':tipId/status')
  async status(
    @Param('tipId') tipId: string,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<TipStatusView>> {
    response.setHeader('Cache-Control', 'private, no-store');
    requireStatusToken(this.config.STATUS_TOKEN_SECRET, tipId, authorization);
    await this.receipt.check(tipId);
    const view = await tipStatusView(this.database.db, tipId, new Date());
    if (!view) throw new NotFoundException();
    // Live updates on: the receipt may follow this tip on /v1/tips/:tipId/events. Off: no new
    // request at all, so the field says false rather than being left out.
    return { data: { ...view, live: this.config.LIVE_UPDATES_ENABLED } };
  }

  /**
   * "Stop {name} recognising me" (repeat supporters), from any receipt with its status token. The
   * tip's supporter goes, and with it the grouping of all their past tips to this recipient; the
   * tips stay. 204 whether or not there was anything to stop, so it is safe to repeat. It works
   * whatever SUPPORTER_RECOGNITION says: stopping is always the supporter's to do.
   */
  @Post(':tipId/recognition/stop')
  @HttpCode(204)
  async stopRecognition(
    @Param('tipId') tipId: string,
    @Headers('authorization') authorization: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    response.setHeader('Cache-Control', 'private, no-store');
    requireStatusToken(this.config.STATUS_TOKEN_SECRET, tipId, authorization);
    await stopRecognition(this.database.db, tipId);
  }
}
