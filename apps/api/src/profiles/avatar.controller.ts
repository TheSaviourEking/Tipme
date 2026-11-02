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
  readUpload,
  reencodeTo,
  sendImage,
  withSlot,
} from './image-upload.js';
import { PHOTO_STORE } from './photo-store.provider.js';
import { ProfileRevalidator } from './revalidate.js';

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
    return { data: updated };
  }

  /** Public, but only for live pages. */
  @Get('avatars/:profileId/:file')
  @Header('X-Content-Type-Options', 'nosniff')
  async serve(
    @Param('profileId') profileId: string,
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
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
