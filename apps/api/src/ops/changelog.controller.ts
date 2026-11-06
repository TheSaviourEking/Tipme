import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  opsChangelogDecisionSchema,
  opsChangelogEditSchema,
  opsChangelogQuerySchema,
  opsReasonSchema,
  type ApiDataResponse,
  type OpsActedAlone,
  type OpsChangelogDecision,
  type OpsChangelogEdit,
  type OpsChangelogEntry,
  type OpsChangelogList,
  type OpsChangelogQuery,
  type OpsReasonRequest,
  type OpsSeriousPending,
} from '@tipme/contracts';
import {
  approveChangelogEntry,
  askToPublishChangelogEntry,
  editChangelogEntry,
  listChangelog,
  readChangelogEntry,
  withdrawChangelogEntry,
  type SeriousActionServices,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { FreshCode } from './fresh-code.guard.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';

const MAX_NUMBER = 2_147_483_647;

/** A PR number as the path gives it: digits only, no sign, no leading zero. Anything else is no entry. */
function entryNumber(raw: string): number {
  const number = /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : 0;
  if (number < 1 || number > MAX_NUMBER)
    throw new CodedHttpException(404, 'CHANGELOG_NOT_FOUND');
  return number;
}

/**
 * The changelog in admin (changelog plan, 5 Nov 2026, Design §4 and §5). Reading, saving and
 * withdrawing are open to `changelog.edit` or `changelog.publish` with no fresh code: editing is not
 * sensitive, and hiding an entry must work at once (a reason and the audit still apply). Approving
 * is `changelog.publish` with a fresh code, and is the one approval. Asking is `changelog.edit`
 * through the serious-action flow, which asserts the code too.
 */
@Controller('v1/ops/changelog')
export class OpsChangelogController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
  ) {}

  @Get()
  @RateLimit('ops_read')
  @OpsPermission('changelog.edit', 'changelog.publish')
  async list(
    @Query(new ZodValidationPipe(opsChangelogQuerySchema))
    query: OpsChangelogQuery,
  ): Promise<ApiDataResponse<OpsChangelogList>> {
    return {
      data: await listChangelog(this.database.db, {
        view: query.view,
        ...(query.before === undefined ? {} : { before: query.before }),
      }),
    };
  }

  @Get(':number')
  @RateLimit('ops_read')
  @OpsPermission('changelog.edit', 'changelog.publish')
  async entry(
    @Param('number') number: string,
  ): Promise<ApiDataResponse<OpsChangelogEntry>> {
    return {
      data: await readChangelogEntry(this.database.db, entryNumber(number)),
    };
  }

  @Put(':number')
  @RateLimit('ops_request')
  @OpsPermission('changelog.edit', 'changelog.publish')
  async edit(
    @CurrentOps() ops: OpsContext,
    @Param('number') number: string,
    @Body(new ZodValidationPipe(opsChangelogEditSchema)) body: OpsChangelogEdit,
  ): Promise<ApiDataResponse<OpsChangelogEntry>> {
    return {
      data: await editChangelogEntry(this.database.db, {
        staffUserId: ops.userId,
        number: entryNumber(number),
        patch: body,
      }),
    };
  }

  @Post(':number/ask')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('changelog.edit')
  async ask(
    @CurrentOps() ops: OpsContext,
    @Param('number') number: string,
    @Body(new ZodValidationPipe(opsChangelogDecisionSchema))
    body: OpsChangelogDecision,
    @Res({ passthrough: true }) response: Response,
  ): Promise<
    ApiDataResponse<OpsSeriousPending | (OpsChangelogEntry & OpsActedAlone)>
  > {
    const answer = pendingOr<OpsChangelogEntry>(
      await askToPublishChangelogEntry(this.database.db, {
        actorId: ops.userId,
        grantId: ops.grantId,
        number: entryNumber(number),
        revision: body.revision,
        reason: body.reason,
        services: this.services,
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }

  @Post(':number/approve')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('changelog.publish')
  async approve(
    @CurrentOps() ops: OpsContext,
    @Param('number') number: string,
    @Body(new ZodValidationPipe(opsChangelogDecisionSchema))
    body: OpsChangelogDecision,
  ): Promise<ApiDataResponse<OpsChangelogEntry>> {
    return {
      data: await approveChangelogEntry(this.database.db, {
        number: entryNumber(number),
        revision: body.revision,
        approverId: ops.userId,
        reason: body.reason,
      }),
    };
  }

  @Post(':number/withdraw')
  @HttpCode(200)
  @RateLimit('ops_request')
  @OpsPermission('changelog.edit', 'changelog.publish')
  async withdraw(
    @CurrentOps() ops: OpsContext,
    @Param('number') number: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsChangelogEntry>> {
    return {
      data: await withdrawChangelogEntry(this.database.db, {
        staffUserId: ops.userId,
        number: entryNumber(number),
        reason: body.reason,
      }),
    };
  }
}
