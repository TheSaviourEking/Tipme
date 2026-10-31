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
import {
  claimReceiptCheck,
  reconcileAttempts,
  tipStatusView,
} from '@tipme/database';
import type { BachsProvider } from '@tipme/payments';
import type { Response } from 'express';
import { z } from 'zod';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { BACHS_PROVIDER_TOKEN } from './payment-provider.provider.js';
import { verifyStatusToken } from './status-token.js';

const tipIdSchema = z.uuid();
/** The receipt polls every second at first; Bachs is asked at most this often per tip. */
const RECEIPT_CHECK_GAP_MS = 4_000;

/**
 * A supporter's receipt. Readable only with the tip's status token; a wrong or missing token is
 * indistinguishable from an unknown tip (404), so it reveals nothing.
 */
@Controller('v1/tips')
export class StatusController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(BACHS_PROVIDER_TOKEN)
    private readonly bachs: Pick<BachsProvider, 'verifyTransaction'> | null,
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
    await this.askBachs(tipId);
    const view = await tipStatusView(this.database.db, tipId, new Date());
    if (!view) throw new NotFoundException();
    return { data: view };
  }

  /**
   * A supporter back from Bachs' checkout is watching: read the payment from Bachs now, with the
   * worker's own checks, instead of waiting for a webhook or the worker's next round. A failed
   * read changes nothing; the receipt keeps waiting and the worker keeps checking.
   */
  private async askBachs(tipId: string): Promise<void> {
    if (!this.bachs) return;
    const now = new Date();
    const attemptId = await claimReceiptCheck(this.database.db, {
      tipId,
      provider: 'bachs',
      now,
      minGapMs: RECEIPT_CHECK_GAP_MS,
    });
    if (!attemptId) return;
    const bachs = this.bachs;
    await reconcileAttempts({
      db: this.database.db,
      provider: {
        verifyTransaction: (reference, expectation) =>
          bachs.verifyTransaction(reference, expectation),
      },
      now,
      minAgeMs: 0,
      attemptId,
    });
  }
}
