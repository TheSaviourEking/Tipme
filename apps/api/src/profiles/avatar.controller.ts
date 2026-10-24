import {
  Controller,
  Delete,
  Get,
  Header,
  Inject,
  Param,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { ApiDataResponse, MyProfile } from '@tipme/contracts';
import { avatarFor, removeAvatar, setAvatar } from '@tipme/database';
import type { Request, Response } from 'express';
import sharp from 'sharp';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from './revalidate.js';

// Profile photos (PR-013). An upload is never stored as sent: it is decoded and re-encoded here
// to a 512×512 WebP, which drops all metadata (EXIF location, camera details). Only real JPEG,
// PNG and WebP photos are accepted; SVG never (it can carry script).

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Refuses "pixel bombs": small files that decode to enormous images.
const MAX_INPUT_PIXELS = 40_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

sharp.cache(false);

/** The request body, read here (no parser handles images), refused past `MAX_BYTES`. */
async function readUpload(request: Request): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? 0);
  if (declared > MAX_BYTES)
    throw new CodedHttpException(413, 'PAYLOAD_TOO_LARGE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BYTES)
      throw new CodedHttpException(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Decodes and re-encodes; anything that is not a decodable JPEG/PNG/WebP is INVALID_IMAGE. */
async function reencode(input: Buffer): Promise<Buffer> {
  try {
    const image = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
    });
    const { format } = await image.metadata();
    if (format !== 'jpeg' && format !== 'png' && format !== 'webp')
      throw new Error('unsupported format');
    return await image
      .rotate() // honour the camera's orientation before the metadata is dropped
      .resize(512, 512, { fit: 'cover' })
      .webp({ quality: 80 })
      .toBuffer();
  } catch {
    throw new CodedHttpException(400, 'INVALID_IMAGE');
  }
}

@Controller('v1')
export class AvatarController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
  ) {}

  @Put('me/avatar')
  @UseGuards(SessionGuard, CsrfGuard)
  async upload(
    @CurrentUser() auth: AuthContext,
    @Req() request: Request,
  ): Promise<ApiDataResponse<MyProfile>> {
    const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!ACCEPTED.has(type)) throw new CodedHttpException(415, 'INVALID_IMAGE');
    const webp = await reencode(await readUpload(request));
    const updated = await setAvatar(this.database.db, auth.userId, webp);
    this.revalidator.revalidate(updated.handle);
    return { data: updated };
  }

  @Delete('me/avatar')
  @UseGuards(SessionGuard, CsrfGuard)
  async remove(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await removeAvatar(this.database.db, auth.userId);
    this.revalidator.revalidate(updated.handle);
    return { data: updated };
  }

  /**
   * Public, but only for live pages. A version's URL never changes (a new photo is a new
   * version), so it caches, but for a day only: a hidden page's photo should not linger long.
   */
  @Get('avatars/:profileId/:file')
  @Header('X-Content-Type-Options', 'nosniff')
  async serve(
    @Param('profileId') profileId: string,
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
    const version = /^(\d{1,9})\.webp$/.exec(file)?.[1];
    const bytes =
      UUID.test(profileId) && version
        ? await avatarFor(this.database.db, {
            profileId,
            version: Number(version),
          })
        : null;
    if (!bytes) throw new CodedHttpException(404, 'NOT_FOUND');
    response
      .status(200)
      .setHeader('Content-Type', 'image/webp')
      .setHeader('Cache-Control', 'public, max-age=86400, immutable')
      .setHeader('Content-Security-Policy', "default-src 'none'")
      .end(bytes);
  }
}
