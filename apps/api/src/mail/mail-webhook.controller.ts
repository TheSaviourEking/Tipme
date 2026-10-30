import {
  BadRequestException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { ApiDataResponse } from '@tipme/contracts';
import { applyMailProviderEvent, type MailSealing } from '@tipme/database';
import { MAIL_PROVIDER_NAMES, type MailProviderName } from '@tipme/mail';
import type { Logger } from '@tipme/observability';
import type { Request } from 'express';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';
import {
  MAIL_PROVIDERS,
  MAIL_SEALING,
  MAIL_SUBSCRIPTION_CONFIRM,
  type ConfirmSubscription,
  type MailProviders,
} from './mail-providers.provider.js';

/**
 * Bounce, complaint, delivery, open and click events from mail providers. Verified before
 * anything is stored; accepted for every configured provider, so events for mail sent before a
 * switch still count. Logs carry the provider and outcome only, never addresses.
 */
@Controller('v1/webhooks/mail')
export class MailWebhookController {
  constructor(
    @Inject(MAIL_PROVIDERS) private readonly providers: MailProviders,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(MAIL_SUBSCRIPTION_CONFIRM)
    private readonly confirmSubscription: ConfirmSubscription,
  ) {}

  @Post(':provider')
  @HttpCode(200)
  async receive(
    @Param('provider') name: string,
    @Req() request: Pick<RawBodyRequest<Request>, 'rawBody' | 'headers'>,
  ): Promise<ApiDataResponse<{ received: number }>> {
    const provider = MAIL_PROVIDER_NAMES.includes(name as MailProviderName)
      ? this.providers.get(name as MailProviderName)
      : undefined;
    if (!provider) throw new NotFoundException();
    const rawBody = request.rawBody ?? Buffer.alloc(0);
    try {
      await provider.prepareWebhook?.(rawBody);
    } catch {
      // A certificate that can't be fetched fails verification below.
    }
    const result = provider.verifyWebhook(rawBody, request.headers, new Date());
    if (!result.ok) {
      this.logger.warn({
        event: 'mail_webhook.rejected',
        provider: provider.name,
        reason: result.reason,
      });
      if (result.reason === 'malformed' || result.reason === 'stale')
        throw new BadRequestException();
      throw new UnauthorizedException();
    }
    if (result.confirmSubscriptionUrl) {
      // Outside any transaction; only the verified SNS URL is ever visited.
      await this.confirmSubscription(result.confirmSubscriptionUrl);
      this.logger.info({
        event: 'mail_webhook.sns_subscribed',
        provider: provider.name,
      });
    }
    const now = new Date();
    for (const event of result.events) {
      const outcome = await applyMailProviderEvent(
        this.database.db,
        this.sealing,
        provider.name,
        event,
        now,
      );
      this.logger.info({
        event: 'mail_webhook.event',
        provider: provider.name,
        kind: event.kind,
        outcome,
      });
    }
    return { data: { received: result.events.length } };
  }
}
