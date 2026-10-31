import {
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { ApiDataResponse } from '@tipme/contracts';
import {
  applyUnsubscribe,
  readUnsubscribeToken,
  type MailSealing,
} from '@tipme/database';
import type { Response } from 'express';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from './mail-providers.provider.js';

/**
 * One-click unsubscribe (RFC 8058). Mail clients POST with no cookie, so the signed token is the
 * whole proof. Opening the link (GET) never changes anything: link scanners open every link.
 */
@Controller('v1/mail/unsubscribe')
export class UnsubscribeController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  show(
    @Query('t') token: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): void {
    const page = new URL('/email/unsubscribed', this.config.WEB_ORIGIN);
    if (typeof token === 'string') page.searchParams.set('t', token);
    response.redirect(303, page.toString());
  }

  @Post()
  @HttpCode(200)
  @RateLimit('unsubscribe')
  async unsubscribe(
    @Query('t') token: string | undefined,
  ): Promise<ApiDataResponse<{ type: string }>> {
    const read =
      typeof token === 'string' && token.length <= 300
        ? readUnsubscribeToken(this.sealing, token)
        : null;
    if (!read) throw new CodedHttpException(400, 'UNSUBSCRIBE_INVALID');
    await applyUnsubscribe(this.database.db, read);
    return { data: { type: read.type } };
  }
}
