import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import {
  opsSplitAccountReadSchema,
  opsSplitAccountsQuerySchema,
  type ApiDataResponse,
  type OpsSplitAccountReadRequest,
  type OpsSplitAccountReading,
  type OpsSplitAccounts,
  type OpsSplitOutcome,
} from '@tipme/contracts';
import {
  listSplitAccounts,
  readSplitAccount,
  recordAudit,
  type safeError,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import type { z } from 'zod';
import {
  PAYOUT_PROVIDERS_TOKEN,
  type PayoutProviderSet,
} from '../checkout/payment-provider.provider.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import {
  PARTNER_QUOTE_CACHE,
  type RedisPartnerQuoteCache,
} from '../infra/partner-quote-cache.js';
import { LOGGER } from '../tokens.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/**
 * Split accounts (per-provider balances, spec §7): the owners whose money is at more than one
 * configured provider, with the ledger, what is queued at each provider and the last daily check.
 * Staff may read one owner's balances at each provider now: audited, and through the quote's
 * cache so it shares the provider's rate limit. Provider names are shown to staff only.
 */
@Controller('v1/ops/split-accounts')
export class OpsSplitAccountsController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(PAYOUT_PROVIDERS_TOKEN)
    private readonly providers: PayoutProviderSet,
    @Inject(PARTNER_QUOTE_CACHE)
    private readonly partnerCache: RedisPartnerQuoteCache,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Get()
  @RateLimit('ops_read')
  @OpsPermission('issues.view')
  @Header('Cache-Control', 'private, no-store')
  async list(
    @Query(new ZodValidationPipe(opsSplitAccountsQuerySchema))
    query: z.infer<typeof opsSplitAccountsQuerySchema>,
  ): Promise<ApiDataResponse<OpsSplitAccounts>> {
    const page = await listSplitAccounts(this.database.db, this.providers, {
      limit: query.limit,
      ...(query.cursor ? { cursor: query.cursor } : {}),
    });
    return {
      data: {
        items: page.items.map((item) => ({
          owner: item.owner,
          ledgerMinor: item.ledgerMinor.toString(),
          providers: item.providers.map((row) => ({
            provider: row.provider,
            role: row.role,
            queuedMinor: row.queuedMinor.toString(),
          })),
          lastCheck: item.lastCheck
            ? {
                checkedAt: item.lastCheck.checkedAt.toISOString(),
                outcome: item.lastCheck.outcome as OpsSplitOutcome,
              }
            : null,
          openIssueId: item.openIssueId,
        })),
        nextCursor: page.nextCursor,
      },
    };
  }

  /** The owner's id goes in the body, as other staff look-ups do, to keep it out of access logs. */
  @Post('read')
  @HttpCode(200)
  @RateLimit('ops_read')
  @OpsPermission('issues.view')
  @Header('Cache-Control', 'private, no-store')
  async read(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsSplitAccountReadSchema))
    body: OpsSplitAccountReadRequest,
  ): Promise<ApiDataResponse<OpsSplitAccountReading[]>> {
    const owner =
      'businessId' in body
        ? { businessId: body.businessId }
        : { profileId: body.profileId };
    const read = await readSplitAccount(
      this.database.db,
      owner,
      this.providers,
      {
        cache: this.partnerCache,
        onReadFailure: (failure: ReturnType<typeof safeError>, provider) =>
          this.logger.warn({
            event: 'split_account.read_failed',
            provider,
            ...failure,
          }),
        // The audit row first: a read that can't be audited doesn't happen.
        beforeRead: () =>
          recordAudit(this.database.db, {
            staffUserId: ops.userId,
            action: 'split_account.read',
            permission: 'issues.view',
            subjectType: 'businessId' in owner ? 'business' : 'profile',
            subjectId:
              'businessId' in owner ? owner.businessId : owner.profileId,
          }),
      },
    );
    if (!read) throw new CodedHttpException(404, 'NOT_FOUND');
    return {
      data: read.map((row) => ({
        provider: row.provider,
        availableMinor:
          row.availableMinor === null ? null : row.availableMinor.toString(),
      })),
    };
  }
}
