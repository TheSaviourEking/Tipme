import {
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import {
  changelogDraftSchema,
  changelogPendingSchema,
  changelogReleaseSchema,
  type ApiDataResponse,
  type ChangelogPendingEntry,
} from '@tipme/contracts';
import {
  markReleased,
  pendingForRelease,
  recordChangelogDraft,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import type { Request } from 'express';
import type { z } from 'zod';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import {
  ValidationFailedException,
  ZodValidationPipe,
} from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import { changelogSignatureValid } from './changelog-signature.js';

type SignedRequest = Pick<RawBodyRequest<Request>, 'rawBody' | 'headers'>;
type Route = 'drafts' | 'pending' | 'releases';

const header = (request: SignedRequest, name: string) => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

/**
 * What CI tells TipMe about the changelog (changelog plan, Design §3): a merged PR's draft, the
 * entries an environment has not run yet, and the ones a deployed version contains. Every request
 * is signed with CHANGELOG_SIGNING_SECRET and checked before its body is parsed; without the
 * secret these routes do not exist (404). The PR body is never stored or logged: logs carry the
 * route and outcome only.
 */
@Controller('v1/webhooks/changelog')
export class ChangelogWebhookController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  @Post('drafts')
  @HttpCode(200)
  @RateLimit('changelog_ingest')
  async drafts(
    @Req() request: SignedRequest,
  ): Promise<ApiDataResponse<{ created: boolean }>> {
    const draft = this.verified(request, 'drafts', changelogDraftSchema);
    const result = await recordChangelogDraft(this.database.db, draft);
    this.logger.info({
      event: 'changelog_webhook.draft',
      created: result.created,
    });
    return { data: result };
  }

  @Post('pending')
  @HttpCode(200)
  @RateLimit('changelog_ingest')
  async pending(
    @Req() request: SignedRequest,
  ): Promise<ApiDataResponse<ChangelogPendingEntry[]>> {
    const { environment } = this.verified(
      request,
      'pending',
      changelogPendingSchema,
    );
    return { data: await pendingForRelease(this.database.db, environment) };
  }

  @Post('releases')
  @HttpCode(200)
  @RateLimit('changelog_ingest')
  async releases(
    @Req() request: SignedRequest,
  ): Promise<ApiDataResponse<{ marked: number[] }>> {
    const release = this.verified(request, 'releases', changelogReleaseSchema);
    const result = await markReleased(this.database.db, release);
    this.logger.info({
      event: 'changelog_webhook.released',
      environment: release.environment,
      marked: result.marked.length,
    });
    return { data: result };
  }

  /** The signature first, then JSON, then the schema; anything before a valid signature is a 401. */
  private verified<S extends z.ZodType>(
    request: SignedRequest,
    route: Route,
    schema: S,
  ): z.infer<S> {
    const secret = this.config.CHANGELOG_SIGNING_SECRET;
    if (!secret) throw new NotFoundException();
    const raw = request.rawBody ?? Buffer.alloc(0);
    if (
      !changelogSignatureValid({
        secret,
        timestamp: header(request, 'x-tipme-timestamp'),
        signature: header(request, 'x-tipme-signature'),
        raw,
        now: Date.now(),
      })
    ) {
      this.logger.warn({ event: 'changelog_webhook.rejected', route });
      throw new CodedHttpException(401, 'CHANGELOG_SIGNATURE_INVALID');
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new ValidationFailedException(['(body)']);
    }
    return new ZodValidationPipe(schema).transform(body);
  }
}
