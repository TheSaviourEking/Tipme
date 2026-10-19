import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type {
  ApiDataResponse,
  MyProfile,
  NotificationView,
} from '@tipme/contracts';
import {
  cancelRecoveries,
  changePhone,
  checkRecoveryToken,
  completeRecovery,
  confirmEmailForUser,
  getMyProfile,
  listNotifications,
  markRead,
  pendingRecoveries,
  requestSignInCode,
  startEmailVerification,
  startRecovery,
} from '@tipme/database';
import { z } from 'zod';
import { CsrfGuard } from '../auth/csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from '../auth/session.guard.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { ProfileRevalidator } from '../profiles/revalidate.js';

const idsSchema = z.object({ ids: z.array(z.uuid()).max(100) }).strict();
const emailSchema = z.object({ email: z.string().min(3).max(254) }).strict();
const tokenSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) })
  .strict();
const phoneSchema = z.object({ phone: z.string().min(3).max(32) }).strict();
const phoneCodeSchema = z
  .object({
    phone: z.string().min(3).max(32),
    code: z.string().regex(/^\d{6}$/),
  })
  .strict();
const recoverCodeSchema = tokenSchema
  .extend({ phone: z.string().min(3).max(32) })
  .strict();
const recoverCompleteSchema = recoverCodeSchema
  .extend({ code: z.string().regex(/^\d{6}$/) })
  .strict();

/** Notifications, email verification, phone change and recovery (ADR-0003). */
@Controller('v1')
@UseGuards(CsrfGuard)
export class NotificationsController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(ProfileRevalidator)
    private readonly revalidator: ProfileRevalidator,
  ) {}

  @Get('me/notifications')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'private, no-store')
  async list(
    @CurrentUser() auth: AuthContext,
    @Query('unreadOnly') unreadOnly?: string,
  ): Promise<ApiDataResponse<NotificationView[]>> {
    return {
      data: await listNotifications(this.database.db, auth.userId, {
        unreadOnly: unreadOnly === '1',
      }),
    };
  }

  @Post('me/notifications/read')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async read(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(idsSchema)) body: z.infer<typeof idsSchema>,
  ): Promise<void> {
    await markRead(this.database.db, auth.userId, body.ids);
  }

  @Post('me/email')
  @HttpCode(202)
  @UseGuards(SessionGuard)
  @RateLimit('auth_code')
  async addEmail(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(emailSchema)) body: z.infer<typeof emailSchema>,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    await startEmailVerification(this.database.db, {
      userId: auth.userId,
      email: body.email,
      webOrigin: this.config.WEB_ORIGIN,
    });
    return { data: { sent: true } };
  }

  @Post('auth/email/confirm')
  @HttpCode(200)
  @RateLimit('auth_verify')
  async confirm(
    @Body(new ZodValidationPipe(tokenSchema)) body: z.infer<typeof tokenSchema>,
  ): Promise<ApiDataResponse<{ confirmed: true }>> {
    const result = await confirmEmailForUser(this.database.db, {
      token: body.token,
    });
    if (result.status !== 'confirmed')
      throw new CodedHttpException(400, 'CODE_INVALID');
    // A public email must appear on the page at once.
    if (result.handle) this.revalidator.revalidate(result.handle);
    return { data: { confirmed: true } };
  }

  @Post('me/phone/code')
  @HttpCode(202)
  @UseGuards(SessionGuard)
  @RateLimit('auth_code')
  async phoneCode(
    @Body(new ZodValidationPipe(phoneSchema)) body: z.infer<typeof phoneSchema>,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    await requestSignInCode(this.database.db, {
      phone: body.phone,
      purpose: 'change_phone',
      secret: this.config.AUTH_CODE_SECRET,
    });
    return { data: { sent: true } };
  }

  @Put('me/phone')
  @UseGuards(SessionGuard)
  @RateLimit('auth_verify')
  async changePhone(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(phoneCodeSchema))
    body: z.infer<typeof phoneCodeSchema>,
  ): Promise<ApiDataResponse<MyProfile>> {
    await changePhone(this.database.db, {
      userId: auth.userId,
      newPhone: body.phone,
      code: body.code,
      secret: this.config.AUTH_CODE_SECRET,
      keepSessionId: auth.sessionId,
    });
    const profile = await getMyProfile(this.database.db, auth.userId);
    // A public phone number must change on the page at once.
    this.revalidator.revalidate(profile.handle);
    return { data: profile };
  }

  @Get('me/recovery')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'private, no-store')
  async recoveries(
    @CurrentUser() auth: AuthContext,
  ): Promise<
    ApiDataResponse<{ id: string; newPhoneHint: string; effectiveAt: string }[]>
  > {
    return { data: await pendingRecoveries(this.database.db, auth.userId) };
  }

  @Post('me/recovery/cancel')
  @UseGuards(SessionGuard)
  async cancelRecovery(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<{ cancelled: number }>> {
    return {
      data: {
        cancelled: await cancelRecoveries(this.database.db, auth.userId),
      },
    };
  }

  /** Always 202: never reveals which addresses have accounts. */
  @Post('auth/recover')
  @HttpCode(202)
  @RateLimit('auth_code')
  async recover(
    @Body(new ZodValidationPipe(emailSchema)) body: z.infer<typeof emailSchema>,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    await startRecovery(this.database.db, {
      email: body.email,
      webOrigin: this.config.WEB_ORIGIN,
    });
    return { data: { sent: true } };
  }

  @Post('auth/recover/code')
  @HttpCode(202)
  @RateLimit('auth_code')
  async recoverCode(
    @Body(new ZodValidationPipe(recoverCodeSchema))
    body: z.infer<typeof recoverCodeSchema>,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    if (!(await checkRecoveryToken(this.database.db, body.token)))
      throw new CodedHttpException(400, 'CODE_INVALID');
    await requestSignInCode(this.database.db, {
      phone: body.phone,
      purpose: 'change_phone',
      secret: this.config.AUTH_CODE_SECRET,
    });
    return { data: { sent: true } };
  }

  /**
   * Starts moving the account to the new number. It takes effect 24 hours later (signing in with
   * that number then completes it); the owner is warned and can cancel meanwhile.
   */
  @Post('auth/recover/complete')
  @HttpCode(202)
  @RateLimit('auth_verify')
  async recoverComplete(
    @Body(new ZodValidationPipe(recoverCompleteSchema))
    body: z.infer<typeof recoverCompleteSchema>,
  ): Promise<ApiDataResponse<{ pendingUntil: string }>> {
    const { pendingUntil } = await completeRecovery(this.database.db, {
      token: body.token,
      newPhone: body.phone,
      code: body.code,
      secret: this.config.AUTH_CODE_SECRET,
    });
    return { data: { pendingUntil: pendingUntil.toISOString() } };
  }
}
