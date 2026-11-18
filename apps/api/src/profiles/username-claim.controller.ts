import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  claimLinkCodeSchema,
  type ApiDataResponse,
  type ClaimLinkCode,
  type ClaimLinkPreview,
  type UsernameClaimed,
} from '@tipme/contracts';
import { claimViaHandoverLink, previewHandoverLink } from '@tipme/database';
import { ServerEvents } from '../analytics/server-events.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { ProfileRevalidator } from './revalidate.js';

/*
 * Username claim links (handover, owner's approval 18 Nov 2026). The code travels only in a request
 * body: the link keeps it in the fragment, so no URL a server, log or analytics event sees holds it.
 * Previews and claims share one allowance per address (`username_claims`).
 */

/** Anyone holding a link sees what it is, before signing up or in. Only an open link names the name. */
@Controller('v1/handles/claim-link')
export class ClaimLinkPreviewController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Post('preview')
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('username_claims')
  async preview(
    @Body(new ZodValidationPipe(claimLinkCodeSchema)) body: ClaimLinkCode,
  ): Promise<ApiDataResponse<ClaimLinkPreview>> {
    return { data: await previewHandoverLink(this.database.db, body.code) };
  }
}

/** The signed-in person claims the name. Their old username, if any, keeps leading to the page. */
@Controller('v1/me/username-claim')
@UseGuards(SessionGuard, CsrfGuard)
export class UsernameClaimController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Inject(ServerEvents) private readonly events: ServerEvents,
    @Inject(LIVE_PUBLISHER) private readonly publishLive: PublishLive,
  ) {}

  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'private, no-store')
  @RateLimit('username_claims')
  async claim(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(claimLinkCodeSchema)) body: ClaimLinkCode,
  ): Promise<ApiDataResponse<UsernameClaimed>> {
    const claimed = await claimViaHandoverLink(this.database.db, {
      userId: auth.userId,
      code: body.code,
    });
    if (claimed.previous) this.revalidator.revalidateGone(claimed.previous);
    this.revalidator.revalidate(claimed.handle);
    if (claimed.created)
      await this.events.record(
        'profile_created',
        `profile_created.${claimed.profileId}`,
        claimed.profileId,
      );
    // This person's other tabs re-read their profile (never awaited, never thrown).
    void this.publishLive({
      to: { user: auth.userId },
      type: 'profile.changed',
    });
    return {
      data: {
        handle: claimed.handle,
        previous: claimed.previous,
        created: claimed.created,
      },
    };
  }
}
