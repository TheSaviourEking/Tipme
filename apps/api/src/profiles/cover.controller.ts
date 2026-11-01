import {
  Body,
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
import {
  coverDesignChoiceSchema,
  type ApiDataResponse,
  type CoverDesignChoice,
  type MyProfile,
} from '@tipme/contracts';
import {
  coverFor,
  removeCover,
  setCover,
  setCoverDesign,
  type PhotoStore,
} from '@tipme/database';
import type { Request, Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import {
  imageVersion,
  readUpload,
  reencodeTo,
  sendImage,
  withSlot,
} from './image-upload.js';
import { PHOTO_STORE } from './photo-store.provider.js';
import { ProfileRevalidator } from './revalidate.js';

// Page covers: 2240×600, twice the widest the page shows. The safeguards every upload gets are in
// image-upload.ts, and uploads share the photo upload's rate limit and re-encoding slots.
const toCover = reencodeTo(2240, 600);

@Controller('v1')
export class CoverController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
  ) {}

  @Put('me/cover')
  @UseGuards(SessionGuard, CsrfGuard)
  @RateLimit('avatars')
  async upload(
    @CurrentUser() auth: AuthContext,
    @Req() request: Request,
  ): Promise<ApiDataResponse<MyProfile>> {
    const upload = await readUpload(request);
    const webp = await withSlot(() => toCover(upload));
    const updated = await setCover(
      this.database.db,
      auth.userId,
      webp,
      this.photos ?? undefined,
    );
    this.revalidator.revalidate(updated.handle);
    return { data: updated };
  }

  @Delete('me/cover')
  @UseGuards(SessionGuard, CsrfGuard)
  async remove(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await removeCover(
      this.database.db,
      auth.userId,
      this.photos ?? undefined,
    );
    this.revalidator.revalidate(updated.handle);
    return { data: updated };
  }

  @Put('me/cover-design')
  @UseGuards(SessionGuard, CsrfGuard)
  async chooseDesign(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(coverDesignChoiceSchema))
    body: CoverDesignChoice,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await setCoverDesign(this.database.db, auth.userId, body);
    this.revalidator.revalidate(updated.handle);
    return { data: updated };
  }

  /** Public, but only for live pages. */
  @Get('covers/:profileId/:file')
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
        : await coverFor(
            this.database.db,
            { profileId, version },
            this.photos ?? undefined,
          ),
    );
  }
}
