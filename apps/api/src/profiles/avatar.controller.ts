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
import sharp from 'sharp';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { DatabaseProvider } from '../infra/database.js';
import type { PhotoStore } from '@tipme/database';
import { PHOTO_STORE } from './photo-store.provider.js';
import { ProfileRevalidator } from './revalidate.js';

// Profile photos (PR-013). An upload is never stored as sent: it is decoded and re-encoded here
// to a 512×512 WebP, which drops all metadata (EXIF location, camera details). Only real JPEG,
// PNG and WebP photos are accepted; SVG never (it can carry script).

const MAX_BYTES = 5 * 1024 * 1024;
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);
// Refuses "pixel bombs": small files that decode to enormous images. 25 MP covers any phone
// photo, and the browser shrinks photos before sending them anyway.
const MAX_INPUT_PIXELS = 25_000_000;
// At most this many photos are re-encoded at once in one API process: decoding runs on the
// thread pool every request shares, so a burst of uploads must not slow everything else.
const MAX_CONCURRENT = 2;
let running = 0;
const waiting: (() => void)[] = [];
async function withSlot<T>(work: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT)
    await new Promise<void>((resolve) => waiting.push(resolve));
  running += 1;
  try {
    return await work();
  } finally {
    running -= 1;
    waiting.shift()?.();
  }
}
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
    // failOn 'error' (not sharp's stricter 'warning') accepts phone photos with harmless
    // quirks; it is safe because every upload is re-encoded, never stored as sent.
    const image = sharp(input, {
      limitInputPixels: MAX_INPUT_PIXELS,
      failOn: 'error',
    }).timeout({ seconds: 5 });
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
    const type = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
    if (!ACCEPTED.has(type)) throw new CodedHttpException(415, 'INVALID_IMAGE');
    const upload = await readUpload(request);
    const webp = await withSlot(() => reencode(upload));
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

  /**
   * Public, but only for live pages. A version's URL is never reused (a new photo is a new
   * version), so it caches, but for an hour only: a hidden page's photo should not linger.
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
        ? await avatarFor(
            this.database.db,
            { profileId, version: Number(version) },
            this.photos ?? undefined,
          )
        : null;
    if (!bytes) throw new CodedHttpException(404, 'NOT_FOUND');
    response
      .status(200)
      .setHeader('Content-Type', 'image/webp')
      .setHeader('Cache-Control', 'public, max-age=3600, immutable')
      .setHeader('Content-Security-Policy', "default-src 'none'")
      .end(bytes);
  }
}
