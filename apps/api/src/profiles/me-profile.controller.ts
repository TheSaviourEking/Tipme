import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Inject,
  Patch,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  claimHandleSchema,
  deleteAccountSchema,
  pageStateSchema,
  profilePatchSchema,
  renameHandleSchema,
  type ApiDataResponse,
  type MyProfile,
  type ProfilePatch,
} from '@tipme/contracts';
import {
  claimHandle,
  deleteAccount,
  getMyProfile,
  removeMyAvatar,
  setMyAvatar,
  renameHandle,
  setPageState,
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
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from './revalidate.js';

/** The signed-in recipient's own page. Every route acts only on the caller's account. */
@Controller('v1/me')
@UseGuards(SessionGuard, CsrfGuard)
export class MeProfileController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
  ) {}

  @Post('page')
  async claim(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(claimHandleSchema))
    body: z.infer<typeof claimHandleSchema>,
    @Headers('x-tipme-rehearsal') rehearsal: string | undefined,
  ): Promise<ApiDataResponse<MyProfile>> {
    await claimHandle(this.database.db, {
      userId: auth.userId,
      handle: body.handle,
      // The release check's page (PR-010): only on test copies, only for an open run.
      ...(this.config.RELEASE_KIND === 'test' && rehearsal
        ? { rehearsalRunId: rehearsal }
        : {}),
    });
    return { data: await getMyProfile(this.database.db, auth.userId) };
  }

  @Get('profile')
  async profile(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyProfile>> {
    return { data: await getMyProfile(this.database.db, auth.userId) };
  }

  @Patch('profile')
  async update(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(profilePatchSchema)) body: ProfilePatch,
  ): Promise<ApiDataResponse<MyProfile>> {
    const updated = await updateMyProfile(this.database.db, auth.userId, body);
    this.revalidator.revalidate(updated.handle);
    return { data: updated };
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
    });
    if (previous !== handle) {
      this.revalidator.revalidateGone(previous);
      this.revalidator.revalidate(handle);
    }
    return { data: await getMyProfile(this.database.db, auth.userId) };
  }

  @Put('page/state')
  async state(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(pageStateSchema))
    body: z.infer<typeof pageStateSchema>,
  ): Promise<ApiDataResponse<MyProfile>> {
    const { handle } = await setPageState(
      this.database.db,
      auth.userId,
      body.state,
    );
    this.revalidator.revalidate(handle);
    return { data: await getMyProfile(this.database.db, auth.userId) };
  }

  /** A profile photo: the raw WebP body the browser made (any metadata is refused). */
  @Put('avatar')
  async setAvatar(
    @CurrentUser() auth: AuthContext,
    @Body() body: unknown,
  ): Promise<ApiDataResponse<MyProfile>> {
    if (!Buffer.isBuffer(body))
      throw new CodedHttpException(415, 'VALIDATION_FAILED');
    await setMyAvatar(this.database.db, {
      userId: auth.userId,
      bytes: new Uint8Array(body),
    });
    const profile = await getMyProfile(this.database.db, auth.userId);
    this.revalidator.revalidate(profile.handle);
    return { data: profile };
  }

  @Delete('avatar')
  async removeAvatar(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<MyProfile>> {
    await removeMyAvatar(this.database.db, auth.userId);
    const profile = await getMyProfile(this.database.db, auth.userId);
    this.revalidator.revalidate(profile.handle);
    return { data: profile };
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
      userId: auth.userId,
    });
    this.revalidator.revalidate(handle);
    clearSessionCookie(response, this.config);
  }
}
