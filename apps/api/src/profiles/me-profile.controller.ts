import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  claimHandleSchema,
  deleteAccountSchema,
  myLinksSchema,
  pageStateSchema,
  profilePatchSchema,
  notificationPrefsSchema,
  renameHandleSchema,
  thanksPatchSchema,
  tipAmountsSchema,
  type ApiDataResponse,
  type MyLinksRequest,
  type MyProfile,
  type NotificationPrefs,
  type NotificationPrefsView,
  type ProfilePatch,
  type ThanksPatch,
  type TipAmountsRequest,
} from '@tipme/contracts';
import {
  claimHandle,
  deleteAccount,
  getMyProfile,
  markTakeBackSeen,
  getNotificationPrefs,
  setNotificationPrefs,
  renameHandle,
  setMyLinks,
  setTipAmounts,
  setPageState,
  setThanks,
  updateMyProfile,
} from '@tipme/database';
import type { Response } from 'express';
import type { z } from 'zod';
import { clearSessionCookie } from '../auth/cookies.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { sessionsChanged } from '@tipme/contracts';
import { ServerEvents } from '../analytics/server-events.js';
import type { PhotoStore } from '@tipme/database';
import { PHOTO_STORE } from './photo-store.provider.js';
import { ProfileRevalidator } from './revalidate.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import type { MailSealing } from '@tipme/database';

/** The signed-in recipient's own page. Every route acts only on the caller's account. */
@Controller('v1/me')
@UseGuards(SessionGuard, CsrfGuard)
export class MeProfileController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Inject(ServerEvents) private readonly events: ServerEvents,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(LIVE_PUBLISHER) private readonly publishLive: PublishLive,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
  ) {}

  /** The editor needs to know whether OnlyFans and Fansly links can be added on this copy. */
  private mine(profile: MyProfile): MyProfile {
    return { ...profile, adultLinks: this.config.ADULT_PLATFORM_LINKS };
  }

  @Post('page')
  async claim(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(claimHandleSchema))
    body: z.infer<typeof claimHandleSchema>,
    @Headers('x-tipme-rehearsal') rehearsal: string | undefined,
  ): Promise<ApiDataResponse<MyProfile>> {
    const { profileId } = await claimHandle(this.database.db, {
      userId: auth.userId,
      handle: body.handle,
      // The release check's page (PR-010): only on test copies, only for an open run.
      ...(this.config.RELEASE_KIND === 'test' && rehearsal
        ? { rehearsalRunId: rehearsal }
        : {}),
    });
    await this.events.record(
      'profile_created',
      `profile_created.${profileId}`,
      profileId,
    );
    return {
      data: this.mine(await getMyProfile(this.database.db, auth.userId)),
    };
  }

  @Get('profile')
  async profile(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyProfile>> {
    return {
      data: {
        ...this.mine(await getMyProfile(this.database.db, auth.userId)),
        liveUpdates: this.config.LIVE_UPDATES_ENABLED,
      },
    };
  }

  @Patch('profile')
  async update(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(profilePatchSchema)) body: ProfilePatch,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await updateMyProfile(this.database.db, auth.userId, body);
    this.revalidator.revalidate(updated.handle);
    return { data: this.mine(updated) };
  }

  /**
   * The page's links, whole and in order (SocialLinks board). Free: 3 from Free sites, in catalogue
   * order; more, Pro sites, a featured link or another order are refused (SOCIAL_LINKS_PRO_REQUIRED).
   */
  @Put('links')
  async links(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(myLinksSchema)) body: MyLinksRequest,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await setMyLinks(this.database.db, auth.userId, body, {
      adultLinks: this.config.ADULT_PLATFORM_LINKS,
    });
    this.revalidator.revalidate(updated.handle);
    return { data: this.mine(updated) };
  }

  /** Changes the handle; the old one keeps leading here (PR-011). Both cached pages refresh. */
  @Put('handle')
  async rename(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(renameHandleSchema))
    body: z.infer<typeof renameHandleSchema>,
  ): Promise<ApiDataResponse<MyProfile>> {
    const { previous, handle } = await renameHandle(this.database.db, {
      userId: auth.userId,
      handle: body.handle,
      sealing: this.sealing,
    });
    if (previous !== handle) {
      this.revalidator.revalidateGone(previous);
      this.revalidator.revalidate(handle);
    }
    return {
      data: this.mine(await getMyProfile(this.database.db, auth.userId)),
    };
  }

  /**
   * The dashboard showed the take-back banner in a visible tab. The first call can start the notice
   * clock; later calls change nothing. Someone else's take-back is not found.
   */
  @Post('handle/take-back/:id/seen')
  @HttpCode(200)
  async takeBackSeen(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<MyProfile>> {
    await markTakeBackSeen(this.database.db, {
      userId: auth.userId,
      takeBackId: id,
    });
    return {
      data: this.mine(await getMyProfile(this.database.db, auth.userId)),
    };
  }

  /** A Pro page's own preset amounts and minimum (PR-012); refused on Free (PRO_REQUIRED). */
  @Put('tip-amounts')
  async tipAmounts(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(tipAmountsSchema)) body: TipAmountsRequest,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await setTipAmounts(this.database.db, auth.userId, {
      presetsMinor: body.presetsMinor.map(BigInt),
      minTipMinor: BigInt(body.minMinor),
    });
    this.revalidator.revalidate(updated.handle);
    return { data: this.mine(updated) };
  }

  /**
   * The thank-you line on the supporter's receipt ("Make it yours"). Any plan saves the line; a
   * card style or signature on Free is THANKS_PRO_REQUIRED.
   */
  @Put('thanks')
  async thanks(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(thanksPatchSchema)) body: ThanksPatch,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await setThanks(this.database.db, auth.userId, body);
    // The public page does not show the line; kept so live updates' profile.changed has one place.
    this.revalidator.revalidate(updated.handle);
    return { data: updated };
  }

  @Get('notification-preferences')
  async preferences(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<NotificationPrefsView>> {
    return { data: await getNotificationPrefs(this.database.db, auth.userId) };
  }

  @Put('notification-preferences')
  async setPreferences(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(notificationPrefsSchema))
    body: NotificationPrefs,
  ): Promise<ApiDataResponse<NotificationPrefsView>> {
    return {
      data: await setNotificationPrefs(this.database.db, auth.userId, body),
    };
  }

  @Put('page/state')
  async state(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(pageStateSchema))
    body: z.infer<typeof pageStateSchema>,
  ): Promise<ApiDataResponse<MyProfile>> {
    const { handle, profileId, firstPublished } = await setPageState(
      this.database.db,
      auth.userId,
      body.state,
    );
    this.revalidator.revalidate(handle);
    // Once per page, ever: the first time it goes live (PRD v1.1 §11).
    if (firstPublished)
      await this.events.record(
        'profile_published',
        `profile_published.${profileId}`,
        profileId,
      );
    return {
      data: this.mine(await getMyProfile(this.database.db, auth.userId)),
    };
  }

  @Delete('account')
  @HttpCode(204)
  async remove(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(deleteAccountSchema))
    _body: z.infer<typeof deleteAccountSchema>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const { handle } = await deleteAccount(this.database.db, {
      sealing: this.sealing,
      userId: auth.userId,
      ...(this.photos ? { photos: this.photos } : {}),
    });
    this.revalidator.revalidate(handle);
    clearSessionCookie(response, this.config);
    // Its sessions are gone with the account: every open stream closes.
    void this.publishLive(sessionsChanged(auth.userId));
  }
}
