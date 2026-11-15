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
import type { ApiDataResponse, BusinessDetail } from '@tipme/contracts';
import {
  businessLogoFor,
  managedBusinessLogo,
  removeBusinessLogo,
  setBusinessLogo,
  type PhotoStore,
} from '@tipme/database';
import type { Request, Response } from 'express';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { DatabaseProvider } from '../infra/database.js';
import {
  imageVersion,
  readUpload,
  reencodeTo,
  sendImage,
  sendPrivateImage,
  withSlot,
} from '../profiles/image-upload.js';
import { PHOTO_STORE } from '../profiles/photo-store.provider.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { signalBusiness } from './business-live.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

// A business's logo (owner, 6 Nov 2026): the page photo's pipeline end to end. The same limits,
// signature check and re-encoding (image-upload.ts: JPEG, PNG or WebP up to 5 MB, re-encoded to a
// 512×512 WebP with no metadata), the same rate limit and slots, the same storage (Postgres or R2).
const toLogo = reencodeTo(512, 512);

@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class BusinessLogoController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
    // Optional: integration tests may build this controller without the live module.
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  /** Owners only. The public pages refresh, so the tile shows it promptly. */
  @Put('me/businesses/:id/logo')
  @UseGuards(SessionGuard, CsrfGuard)
  @RateLimit('avatars')
  async upload(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Req() request: Request,
  ): Promise<ApiDataResponse<BusinessDetail>> {
    const upload = await readUpload(request);
    const webp = await withSlot(() => toLogo(upload));
    const { slug, detail } = await setBusinessLogo(
      this.database.db,
      auth.userId,
      id,
      webp,
      this.photos ?? undefined,
    );
    this.revalidator.revalidateBusiness(slug);
    signalBusiness(this.database.db, this.publishLive, { businessId: id });
    return { data: detail };
  }

  /** Owners only. The tile shows the business's initial again. */
  @Delete('me/businesses/:id/logo')
  @UseGuards(SessionGuard, CsrfGuard)
  async remove(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<ApiDataResponse<BusinessDetail>> {
    const { slug, detail } = await removeBusinessLogo(
      this.database.db,
      auth.userId,
      id,
      this.photos ?? undefined,
    );
    this.revalidator.revalidateBusiness(slug);
    signalBusiness(this.database.db, this.publishLive, { businessId: id });
    return { data: detail };
  }

  /** Any manager's preview, which has to work before the business is verified and while paused. */
  @Get('me/businesses/:id/logo')
  @UseGuards(SessionGuard)
  @Header('X-Content-Type-Options', 'nosniff')
  async own(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
    @Res() response: Response,
  ): Promise<void> {
    sendPrivateImage(
      response,
      await managedBusinessLogo(
        this.database.db,
        auth.userId,
        id,
        this.photos ?? undefined,
      ),
    );
  }

  /** Public, but only for a verified business: a waiting or paused one has no public pages. */
  @Get('business-logos/:businessId/:file')
  @Header('X-Content-Type-Options', 'nosniff')
  async serve(
    @Param('businessId') businessId: string,
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
    const version = imageVersion(businessId, file);
    sendImage(
      response,
      version === null
        ? null
        : await businessLogoFor(
            this.database.db,
            { businessId, version },
            this.photos ?? undefined,
          ),
    );
  }
}
