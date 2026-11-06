import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  noteReviewSchema,
  opsReasonSchema,
  type ApiDataResponse,
  type NoteReview,
  type OpsBusinessNote,
  type OpsReasonRequest,
} from '@tipme/contracts';
import { staffRevealNote, staffReviewNote } from '@tipme/database';
import { BusinessEnabledGuard } from '../business/business-enabled.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/**
 * TipMe for businesses, PR B5: a reported note. Staff read its words only through a reveal with a
 * reason (access-control rule 6), then restore it for the business or remove it. Both audited.
 */
@Controller('v1/ops')
@UseGuards(BusinessEnabledGuard)
export class OpsBusinessNotesController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Post('business-notes/:tipId/reveal')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @FreshCode()
  @OpsPermission('private.view')
  async reveal(
    @CurrentOps() ops: OpsContext,
    @Param('tipId') tipId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsBusinessNote>> {
    return {
      data: await staffRevealNote(this.database.db, {
        staffUserId: ops.userId,
        tipId,
        reason: body.reason,
      }),
    };
  }

  @Post('business-notes/:tipId/review')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('issues.resolve')
  async review(
    @CurrentOps() ops: OpsContext,
    @Param('tipId') tipId: string,
    @Body(new ZodValidationPipe(noteReviewSchema)) body: NoteReview,
  ): Promise<ApiDataResponse<{ outcome: NoteReview['outcome'] }>> {
    await staffReviewNote(this.database.db, {
      staffUserId: ops.userId,
      tipId,
      outcome: body.outcome,
      reason: body.reason,
    });
    return { data: { outcome: body.outcome } };
  }
}
