import {
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Optional,
  Param,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { ApiDataResponse, MyProfile } from '@tipme/contracts';
import { avatarFor, removeAvatar, setAvatar } from '@tipme/database';
import type { Request, Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { DatabaseProvider } from '../infra/database.js';
import type { PhotoStore } from '@tipme/database';
import {
  imageVersion,
  pngVersion,
  readUpload,
  reencodeTo,
  sendImage,
  toSharePng,
  withSlot,
} from './image-upload.js';
import { PHOTO_STORE } from './photo-store.provider.js';
import { ProfileRevalidator } from './revalidate.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';

// Profile photos (PR-013): 512×512. The safeguards every upload gets are in image-upload.ts.
const toAvatar = reencodeTo(512, 512);

@Controller('v1')
export class AvatarController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  @Put('me/avatar')
  @UseGuards(SessionGuard, CsrfGuard)
  @RateLimit('avatars')
  async upload(
    @CurrentUser() auth: AuthContext,
    @Req() request: Request,
  ): Promise<ApiDataResponse<MyProfile>> {
    const upload = await readUpload(request);
    const webp = await withSlot(() => toAvatar(upload));
    const updated = await setAvatar(
      this.database.db,
      auth.userId,
      webp,
      this.photos ?? undefined,
    );
    this.revalidator.revalidate(updated.handle);
    void this.publishLive({
      to: { user: auth.userId },
      type: 'profile.changed',
    });
    return { data: updated };
  }

  @Delete('me/avatar')
  @UseGuards(SessionGuard, CsrfGuard)
  async remove(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await removeAvatar(
      this.database.db,
      auth.userId,
      this.photos ?? undefined,
    );
    this.revalidator.revalidate(updated.handle);
    void this.publishLive({
      to: { user: auth.userId },
      type: 'profile.changed',
    });
    return { data: updated };
  }

  /**
   * Public, but only for live pages. `<n>.webp` is the photo; `<n>.png` the same photo as a small
   * PNG for the web's share cards (next/og cannot draw WebP), under the same rules.
   */
  @Get('avatars/:profileId/:file')
  @Header('X-Content-Type-Options', 'nosniff')
  async serve(
    @Param('profileId') profileId: string,
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
    const png = pngVersion(profileId, file);
    if (png !== null) {
      const webp = await avatarFor(
        this.database.db,
        { profileId, version: png },
        this.photos ?? undefined,
      );
      sendImage(response, webp && (await toSharePng(webp)), 'image/png');
      return;
    }
    const version = imageVersion(profileId, file);
    sendImage(
      response,
      version === null
        ? null
        : await avatarFor(
            this.database.db,
            { profileId, version },
            this.photos ?? undefined,
          ),
    );
  }
}
