import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Inject,
  NotFoundException,
  Param,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  profileReportSchema,
  type ApiDataResponse,
  type HandleStatus,
  type ProfileReportReason,
  type PublicCampaignPage,
  type PublicProfile,
} from '@tipme/contracts';
import {
  checkHandle,
  handleAliasTarget,
  normaliseHandle,
  publicCampaignPage,
  publicProfile,
  reportProfile,
  featureOn,
} from '@tipme/database';
import { bachsEnvironment, liveCheckoutOpenFor } from '@tipme/payments';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { FeatureFlags } from '../feature-flags.js';
import { DatabaseProvider } from '../infra/database.js';

@Controller('v1')
export class PublicProfileController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(FeatureFlags) private readonly flags: FeatureFlags,
  ) {}

  /**
   * A live page's public details. Not live, deleted and unknown pages are all 404. An old handle
   * of a live page (PR-011) answers 308 with the current one, so the web can redirect to it.
   */
  @Get('profiles/:handle')
  @Header('Cache-Control', 'no-store')
  async profile(
    @Param('handle') handle: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<PublicProfile | { movedTo: string }>> {
    // New tips through Bachs need the owner's own ready account in this copy's environment;
    // checkout refuses them otherwise.
    const environment = bachsEnvironment(this.config.PAYMENT_PROVIDER);
    const page = await publicProfile(this.database.db, handle, {
      adultLinks: await featureOn(this.database.db, 'adult_platform_links'),
      recognition: await featureOn(this.database.db, 'supporter_recognition'),
      ...(environment
        ? { requiredAccount: { provider: 'bachs', environment } }
        : {}),
    });
    if (page)
      return {
        data: {
          ...page,
          tippingOpen: liveCheckoutOpenFor(
            this.config,
            page.handle.toLowerCase(),
          ),
        },
      };
    const movedTo = await handleAliasTarget(this.database.db, handle);
    if (!movedTo) throw new NotFoundException();
    response.status(308).setHeader('Location', `/v1/profiles/${movedTo}`);
    return { data: { movedTo } };
  }

  /**
   * A campaign's own page (Pro): headline, description and cover, never the campaign's id, name or
   * results. 404 while campaign pages are switched off, and for a stopped, unknown or page-less
   * campaign, so the web shows the main page as before. The handle must be current: an old one
   * answers 404 too, and the web follows the main page's redirect first.
   */
  @Get('profiles/:handle/campaigns/:slug')
  @Header('Cache-Control', 'no-store')
  async campaignPage(
    @Param('handle') handle: string,
    @Param('slug') slug: string,
  ): Promise<ApiDataResponse<PublicCampaignPage>> {
    if (!(await this.flags.isOn('campaign_pages')))
      throw new NotFoundException();
    const page = await publicCampaignPage(this.database.db, handle, slug);
    if (!page) throw new NotFoundException();
    return { data: page };
  }

  /**
   * Reporting a page (PR-013): impersonation, a scam, abuse or other. Always 202, whether or
   * not such a page exists, so the answer reveals nothing. Rate-limited per address.
   */
  @Post('profiles/:handle/report')
  @HttpCode(202)
  @RateLimit('reports')
  async report(
    @Param('handle') handle: string,
    @Body(new ZodValidationPipe(profileReportSchema))
    body: { reason: ProfileReportReason },
  ): Promise<ApiDataResponse<{ accepted: true }>> {
    await reportProfile(this.database.db, { handle, reason: body.reason });
    return { data: { accepted: true } };
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
