import {
  Controller,
  Get,
  Inject,
  Optional,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  QR_ART_SIZES,
  type ApiDataResponse,
  type QrArtCatalogue,
} from '@tipme/contracts';
import { getMyProfile, myAvatar, type PhotoStore } from '@tipme/database';
import type { Response } from 'express';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { withSlot } from '../profiles/image-upload.js';
import { PHOTO_STORE } from '../profiles/photo-store.provider.js';
import { QR_ART } from './catalogue.js';
import {
  QrArtPhotoRequiredError,
  QrArtPhotoTooLargeError,
  qrMosaicFit,
  renderQrArt,
} from './render.js';

const DEFAULT_SIZE = 512;
const FILE = /^([a-z]{3,12})\.png$/;

// The Pro QR designs. Whether a request gets the page's real link or a marked preview is decided
// here on every request from the page's plan, never from anything the browser sends, and nothing
// is cached: a page that loses Pro gets a preview on its very next request.
@Controller('v1/me/qr-art')
@UseGuards(SessionGuard)
export class QrArtController {
  private readonly webOrigin: string;
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
  ) {
    this.webOrigin = new URL(config.WEB_ORIGIN).origin;
  }

  // Plain http is allowed only for local runs and tests.
  private localHttp() {
    return this.config.NODE_ENV !== 'production';
  }

  private realLink(handle: string) {
    return `${this.webOrigin}/@${handle}?src=qr`;
  }

  @Get()
  @RateLimit('qr_art')
  async catalogue(
    @CurrentUser() auth: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<QrArtCatalogue>> {
    response.setHeader('Cache-Control', 'private, no-store');
    const profile = await getMyProfile(this.database.db, auth.userId);
    const locked = profile.plan !== 'pro';
    let note: string | null = null;
    try {
      // Advice only: nothing is refused because of it.
      if (
        qrMosaicFit(this.realLink(profile.handle), {
          allowLocalHttp: this.localHttp(),
        }).alignmentOnFace
      )
        note =
          'Your link is on the long side, so the code has more detail. A few small squares show over your photo, and it still scans.';
    } catch {
      note = null;
    }
    return {
      data: {
        items: QR_ART.map((art) => ({
          id: art.id,
          name: art.name,
          kind: art.kind,
          locked,
          note: art.id === 'mosaic' ? note : null,
        })),
      },
    };
  }

  @Get(':file')
  @RateLimit('qr_art')
  async image(
    @CurrentUser() auth: AuthContext,
    @Param('file') file: string,
    @Query('size') sizeText: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const id = FILE.exec(file)?.[1];
    const art = QR_ART.find((item) => item.id === id);
    if (!art) throw new CodedHttpException(404, 'NOT_FOUND');
    const size = sizeText === undefined ? DEFAULT_SIZE : Number(sizeText);
    if (
      typeof sizeText === 'object' ||
      !(QR_ART_SIZES as readonly number[]).includes(size)
    )
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    const profile = await getMyProfile(this.database.db, auth.userId);
    const preview = profile.plan !== 'pro';
    const photo =
      art.kind === 'photo'
        ? ((await myAvatar(
            this.database.db,
            auth.userId,
            this.photos ?? undefined,
          )) ?? undefined)
        : undefined;
    const options = {
      id: art.id,
      size,
      ...(photo ? { photo } : {}),
      allowLocalHttp: this.localHttp(),
    };
    let png: Buffer;
    try {
      png = await withSlot(() =>
        renderQrArt(
          preview
            ? { ...options, preview: true, previewOrigin: this.webOrigin }
            : {
                ...options,
                preview: false,
                url: this.realLink(profile.handle),
              },
        ),
      );
    } catch (error) {
      if (error instanceof QrArtPhotoTooLargeError)
        throw new CodedHttpException(422, 'QR_ART_PHOTO_TOO_LARGE');
      if (error instanceof QrArtPhotoRequiredError)
        throw new CodedHttpException(409, 'QR_ART_PHOTO_REQUIRED');
      throw error;
    }
    response
      .status(200)
      .set({
        'Content-Type': 'image/png',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      .send(png);
  }
}
