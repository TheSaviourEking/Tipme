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
  QR_ART_THUMB_SIZE,
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
import { ImageResponse } from '../openapi/image.js';
import { QR_ART, type QrArtId } from './catalogue.js';
import {
  QrArtPhotoRequiredError,
  QrArtPhotoTooLargeError,
  qrMosaicFit,
  renderQrArt,
} from './render.js';

const DEFAULT_SIZE = 512;
const DAY = 86_400;
const FILE = /^([a-z]{3,12})\.png$/;

const artOf = (file: string) => {
  const id = FILE.exec(file)?.[1];
  return QR_ART.find((item) => item.id === id);
};

// The Pro QR designs. Whether a request gets the page's real link or a marked preview is decided
// here on every request from the page's plan, never from anything the browser sends. Full-size
// pictures are never cached, so a page that loses Pro gets a preview on its very next request.
// The list pictures are the exception, because a visit asks for thirty: a Free page's are shared
// and public (they are the same for everyone and lead only to the home page), a Pro page's are
// private and kept for five minutes.
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
    // Advice about the page's real link, so it means something only where that link is used.
    if (!locked)
      try {
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
          // The photo mosaic is made from the page's own photo, so it is never shared.
          thumb:
            locked && art.kind !== 'photo'
              ? `/v1/qr-art/previews/${art.id}.png`
              : `/v1/me/qr-art/thumbs/${art.id}.png`,
          note: art.id === 'mosaic' ? note : null,
        })),
      },
    };
  }

  @Get('thumbs/:file')
  @ImageResponse({
    description:
      'A 256 pixel picture for the design list: a marked preview on a Free page, the real code on a Pro page. Kept privately for five minutes.',
    headers: {
      'X-Qr-Preview': 'Present (1) when the picture is a marked preview.',
    },
  })
  @RateLimit('qr_thumb')
  async thumb(
    @CurrentUser() auth: AuthContext,
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
    await this.send(
      auth,
      file,
      QR_ART_THUMB_SIZE,
      response,
      'private, max-age=300',
    );
  }

  @Get(':file')
  @ImageResponse({
    description:
      'One design as a PNG, never cached: a marked preview on a Free page, the real code on a Pro page.',
    size: QR_ART_SIZES,
    headers: {
      'X-Qr-Preview': 'Present (1) when the picture is a marked preview.',
    },
  })
  @RateLimit('qr_art')
  async image(
    @CurrentUser() auth: AuthContext,
    @Param('file') file: string,
    @Query('size') sizeText: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const size = sizeText === undefined ? DEFAULT_SIZE : Number(sizeText);
    if (
      typeof sizeText === 'object' ||
      !(QR_ART_SIZES as readonly number[]).includes(size)
    )
      throw new CodedHttpException(400, 'VALIDATION_FAILED');
    await this.send(auth, file, size, response, 'private, no-store');
  }

  private async send(
    auth: AuthContext,
    file: string,
    size: number,
    response: Response,
    cache: string,
  ): Promise<void> {
    const art = artOf(file);
    if (!art) throw new CodedHttpException(404, 'NOT_FOUND');
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
    response.status(200).set({
      'Content-Type': 'image/png',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
      ...(preview ? { 'X-Qr-Preview': '1' } : {}),
    });
    response.send(png);
  }
}

/**
 * The marked preview of a design, the same for every Free page: it encodes only the TipMe home
 * page and carries the "Preview" mark, so there is nothing personal in it. Drawn once per design
 * and kept in memory, and public so a browser and the edge can keep it too. The photo mosaic is
 * made from a page's own photo, so it has no shared preview.
 */
@Controller('v1/qr-art')
export class QrArtPreviewController {
  private readonly webOrigin: string;
  private readonly drawn = new Map<QrArtId, Promise<Buffer>>();
  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {
    this.webOrigin = new URL(config.WEB_ORIGIN).origin;
  }

  @Get('previews/:file')
  @ImageResponse({
    description:
      'The shared, public preview of a design: a 256 pixel picture marked Preview that leads to the TipMe home page. Kept for a day.',
    headers: { 'X-Qr-Preview': 'Always 1.' },
  })
  async preview(
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
    const art = artOf(file);
    if (!art || art.kind === 'photo')
      throw new CodedHttpException(404, 'NOT_FOUND');
    let png = this.drawn.get(art.id);
    if (!png) {
      png = withSlot(() =>
        renderQrArt({
          id: art.id,
          size: QR_ART_THUMB_SIZE,
          preview: true,
          previewOrigin: this.webOrigin,
          allowLocalHttp: this.config.NODE_ENV !== 'production',
        }),
      );
      this.drawn.set(art.id, png);
      // A failed draw is not kept.
      png.catch(() => this.drawn.delete(art.id));
    }
    response
      .status(200)
      .set({
        'Content-Type': 'image/png',
        'Cache-Control': `public, max-age=${DAY}`,
        'X-Content-Type-Options': 'nosniff',
        'X-Qr-Preview': '1',
      })
      .send(await png);
  }
}
