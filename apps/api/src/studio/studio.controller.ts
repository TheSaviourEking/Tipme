import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Optional,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  studioDraftSchema,
  studioFocusSchema,
  studioImageFileName,
  studioPublishSchema,
  type ApiDataResponse,
  type MyStudioV1,
  type StudioDraftRequest,
  type StudioFocusRequest,
  type StudioPublishRequest,
} from '@tipme/contracts';
import {
  addStudioImage,
  discardStudioDraft,
  getMyStudio,
  myStudioImageFile,
  publishStudio,
  recordStudioVideoChecks,
  saveStudioDraft,
  setStudioFocus,
  studioImageFile,
  studioImageMaster,
  studioVideoChecksFor,
  studioVideoUrls,
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
import { API_CONFIG, type ApiConfig } from '../config.js';
import {
  CodedHttpException,
  StudioCheckFailedException,
} from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import {
  readUpload,
  sendImage,
  sendPrivateImage,
  withSlot,
} from '../profiles/image-upload.js';
import { PHOTO_STORE } from '../profiles/photo-store.provider.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';
import { masterOf, renditionsOf } from './studio-crops.js';
import { StudioEnabledGuard } from './studio-switch.js';
import {
  pretendVerifyVideo,
  verifyVideo,
  type VideoStatus,
} from './video-verify.js';

// Page Studio (plan 2026-11-12-page-studio, Task 7; styles plan Task 10). Off: every route here
// answers 404. Drafts save without a passing check; publishing runs the design check with the
// server's own facts and the page's real plan, so Free publishes the free styles and a Pro design
// needs Pro (§11). The draft rules for Free, the plan read under the page lock and the write that
// requires Pro live in the database operations; a client claim never decides any of it.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fileOf = (imageId: string, version: string, file: string) => {
  const v = /^\d{1,9}$/.test(version) ? Number(version) : NaN;
  if (!UUID.test(imageId) || !studioImageFileName(file) || !Number.isFinite(v))
    throw new CodedHttpException(404, 'NOT_FOUND');
  return { imageId, version: v, file };
};

@Controller('v1')
@UseGuards(StudioEnabledGuard)
export class StudioController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
    @Optional()
    @Inject(PHOTO_STORE)
    private readonly photos: PhotoStore | null = null,
    @Optional()
    @Inject(LIVE_PUBLISHER)
    private readonly publishLive: PublishLive = async () => undefined,
  ) {}

  private get store() {
    return this.photos ?? undefined;
  }

  /**
   * Asks the video sites about links without a fresh answer, and keeps what they say for a day
   * (owner ruling 5). Server-side only; outside production a pretend check answers, so nothing
   * leaves a test or local machine. Never fails: an unknown answer never blocks.
   */
  private async checkVideos(urls: string[]): Promise<void> {
    const known = await studioVideoChecksFor(this.database.db, urls);
    const ask = urls.filter((url) => !known[url]);
    if (ask.length === 0) return;
    const verify =
      this.config.NODE_ENV === 'production' ? verifyVideo : pretendVerifyVideo;
    const answers: Record<string, VideoStatus> = {};
    await Promise.all(
      ask.map(async (url) => (answers[url] = await verify(url))),
    );
    await recordStudioVideoChecks(this.database.db, answers);
  }

  @Get('me/studio')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'no-store')
  async get(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyStudioV1>> {
    return { data: await getMyStudio(this.database.db, auth.userId) };
  }

  /** Saving never needs a passing design check; the answer carries the server's check. */
  @Put('me/studio/draft')
  @UseGuards(SessionGuard, CsrfGuard)
  @RateLimit('studio_drafts')
  async save(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(studioDraftSchema)) body: StudioDraftRequest,
  ): Promise<ApiDataResponse<MyStudioV1>> {
    const studio = await saveStudioDraft(this.database.db, auth.userId, body);
    // Best effort, in the background: the next save or the publish sees the answer.
    void this.checkVideos(studioVideoUrls(studio.draft)).catch(() => undefined);
    return { data: studio };
  }

  /** The gate: 422 with the server's issues while any remain. There is no "publish anyway". */
  @Post('me/studio/publish')
  @HttpCode(200)
  @UseGuards(SessionGuard, CsrfGuard)
  @RateLimit('studio_drafts')
  async publish(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(studioPublishSchema))
    body: StudioPublishRequest,
  ): Promise<ApiDataResponse<MyStudioV1>> {
    // Any plan may publish; the check (with the plan read under the lock) refuses Pro on Free.
    const current = await getMyStudio(this.database.db, auth.userId);
    // Awaited here (each site has 3 seconds), so a gone video can't be published.
    await this.checkVideos(studioVideoUrls(current.draft));
    const result = await publishStudio(
      this.database.db,
      auth.userId,
      body,
      this.store,
    );
    if (!result.published) throw new StudioCheckFailedException(result.issues);
    this.revalidator.revalidate(result.handle);
    void this.publishLive({
      to: { user: auth.userId },
      type: 'profile.changed',
    });
    return { data: result.studio };
  }

  /** Back to the published version (or nothing); the draft's own photos go with it. */
  @Delete('me/studio/draft')
  @UseGuards(SessionGuard, CsrfGuard)
  async discard(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyStudioV1>> {
    return {
      data: await discardStudioDraft(this.database.db, auth.userId, this.store),
    };
  }

  /** A new photo: re-encoded, cropped around the middle; `meta.imageId` names it. */
  @Post('me/studio/images')
  @UseGuards(SessionGuard, CsrfGuard)
  @RateLimit('avatars')
  async upload(
    @CurrentUser() auth: AuthContext,
    @Req() request: Request,
  ): Promise<ApiDataResponse<MyStudioV1> & { meta: { imageId: string } }> {
    const upload = await readUpload(request);
    const { width, height, files } = await withSlot(async () => {
      const master = await masterOf(upload);
      return {
        width: master.width,
        height: master.height,
        files: {
          master: master.master,
          ...(await renditionsOf(master.master, 50, 50)),
        },
      };
    });
    const { studio, imageId } = await addStudioImage(
      this.database.db,
      auth.userId,
      { width, height, files },
      this.store,
    );
    return { data: studio, meta: { imageId } };
  }

  /** A new focal point: every crop is cut again around it, under a new version. */
  @Put('me/studio/images/:imageId/focus')
  @UseGuards(SessionGuard, CsrfGuard)
  @RateLimit('avatars')
  async focus(
    @CurrentUser() auth: AuthContext,
    @Param('imageId') imageId: string,
    @Body(new ZodValidationPipe(studioFocusSchema)) body: StudioFocusRequest,
  ): Promise<ApiDataResponse<MyStudioV1>> {
    if (!UUID.test(imageId)) throw new CodedHttpException(404, 'NOT_FOUND');
    const master = await studioImageMaster(
      this.database.db,
      auth.userId,
      imageId,
      this.store,
    );
    if (!master) throw new CodedHttpException(404, 'NOT_FOUND');
    const files = await withSlot(() =>
      renditionsOf(master, body.focalX, body.focalY),
    );
    const { studio, handle, published } = await setStudioFocus(
      this.database.db,
      auth.userId,
      { imageId, ...body, files },
      this.store,
    );
    if (published) {
      this.revalidator.revalidate(handle);
      void this.publishLive({
        to: { user: auth.userId },
        type: 'profile.changed',
      });
    }
    return { data: studio };
  }

  /** The owner's crops, for the editor, whatever is published: never cached. */
  @Get('me/studio-images/:imageId/:version/:file')
  @UseGuards(SessionGuard)
  @Header('X-Content-Type-Options', 'nosniff')
  async own(
    @CurrentUser() auth: AuthContext,
    @Param('imageId') imageId: string,
    @Param('version') version: string,
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
    sendPrivateImage(
      response,
      await myStudioImageFile(
        this.database.db,
        auth.userId,
        fileOf(imageId, version, file),
        this.store,
      ),
    );
  }

  /**
   * Public, but only a crop the published version of a live Pro page uses, at its current
   * version; never the master. A version's address is never reused, so it caches (an hour).
   */
  @Get('studio-images/:profileId/:imageId/:version/:file')
  @Header('X-Content-Type-Options', 'nosniff')
  async serve(
    @Param('profileId') profileId: string,
    @Param('imageId') imageId: string,
    @Param('version') version: string,
    @Param('file') file: string,
    @Res() response: Response,
  ): Promise<void> {
    if (!UUID.test(profileId)) throw new CodedHttpException(404, 'NOT_FOUND');
    sendImage(
      response,
      await studioImageFile(
        this.database.db,
        { profileId, ...fileOf(imageId, version, file) },
        this.store,
      ),
    );
  }
}
