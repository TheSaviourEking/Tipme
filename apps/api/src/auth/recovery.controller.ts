import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  emailRecoveryConfirmSchema,
  emailRecoveryProposeSchema,
  emailRecoveryStartSchema,
  recoveryEmailCodeSchema,
  recoveryEmailConfirmSchema,
  recoveryEmailRemoveSchema,
  type ApiDataResponse,
  type PendingEmailRecovery,
  type RecoveryEmailStatus,
} from '@tipme/contracts';
import {
  confirmRecoveredEmail,
  confirmRecoveryEmail,
  maskEmail,
  mailSealing,
  pendingEmailRecoveries,
  proposeRecoveredEmail,
  recoveryEmailOf,
  removeRecoveryEmail,
  requestRecoveryChangeCode,
  requestRecoveryEmailCode,
  startEmailRecovery,
  type MailSealing,
} from '@tipme/database';
import type { z } from 'zod';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { CsrfGuard } from './csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from './session.guard.js';

/** The recovery email, and getting back in with it when the sign-in email is lost. */
@Controller('v1')
@UseGuards(CsrfGuard)
export class RecoveryController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {
    this.sealing = mailSealing(Buffer.from(config.MAIL_SEAL_KEY, 'base64'));
  }

  private readonly sealing: MailSealing;

  @Get('me/recovery-email')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'private, no-store')
  async status(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<RecoveryEmailStatus>> {
    const email = await recoveryEmailOf(this.database.db, auth.userId);
    return {
      data: {
        confirmed: Boolean(email),
        hint: email ? maskEmail(email) : null,
      },
    };
  }

  @Get('me/email-recoveries')
  @UseGuards(SessionGuard)
  @Header('Cache-Control', 'private, no-store')
  async pending(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<PendingEmailRecovery[]>> {
    return {
      data: await pendingEmailRecoveries(this.database.db, auth.userId),
    };
  }

  @Post('me/recovery-email/code')
  @HttpCode(202)
  @UseGuards(SessionGuard)
  @RateLimit('auth_code')
  async requestCode(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(recoveryEmailCodeSchema))
    body: z.infer<typeof recoveryEmailCodeSchema>,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    const outcome = await requestRecoveryEmailCode(
      this.database.db,
      this.sealing,
      {
        userId: auth.userId,
        recoveryEmail: body.email,
        secret: this.config.AUTH_CODE_SECRET,
      },
    );
    if (outcome === 'same_as_sign_in')
      throw new CodedHttpException(409, 'SAME_AS_SIGN_IN_EMAIL');
    if (outcome === 'bad_address')
      throw new CodedHttpException(400, 'EMAIL_INVALID');
    if (outcome !== 'sent') throw new CodedHttpException(429, 'TOO_MANY_CODES');
    return { data: { sent: true } };
  }

  /** A code to the sign-in email, for changing or removing a confirmed recovery email. */
  @Post('me/recovery-email/change-code')
  @HttpCode(202)
  @UseGuards(SessionGuard)
  @RateLimit('auth_code')
  async requestChangeCode(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    const outcome = await requestRecoveryChangeCode(
      this.database.db,
      this.sealing,
      { userId: auth.userId, secret: this.config.AUTH_CODE_SECRET },
    );
    if (outcome === 'no_email')
      throw new CodedHttpException(409, 'NO_SIGN_IN_EMAIL');
    if (outcome !== 'sent') throw new CodedHttpException(429, 'TOO_MANY_CODES');
    return { data: { sent: true } };
  }

  @Post('me/recovery-email')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @RateLimit('auth_verify')
  async confirm(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(recoveryEmailConfirmSchema))
    body: z.infer<typeof recoveryEmailConfirmSchema>,
  ): Promise<ApiDataResponse<{ confirmed: true }>> {
    const outcome = await confirmRecoveryEmail(this.database.db, {
      userId: auth.userId,
      recoveryEmail: body.email,
      code: body.code,
      secret: this.config.AUTH_CODE_SECRET,
      ...(body.signInCode ? { signInCode: body.signInCode } : {}),
    });
    if (outcome === 'taken') throw new CodedHttpException(409, 'EMAIL_TAKEN');
    if (outcome === 'same_as_sign_in')
      throw new CodedHttpException(409, 'SAME_AS_SIGN_IN_EMAIL');
    if (outcome === 'needs_sign_in_code')
      throw new CodedHttpException(409, 'SIGN_IN_CODE_REQUIRED');
    if (outcome !== 'confirmed')
      throw new CodedHttpException(400, 'CODE_INVALID');
    return { data: { confirmed: true } };
  }

  @Post('me/recovery-email/remove')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @RateLimit('auth_verify')
  async remove(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(recoveryEmailRemoveSchema))
    body: z.infer<typeof recoveryEmailRemoveSchema>,
  ): Promise<ApiDataResponse<{ removed: true }>> {
    const outcome = await removeRecoveryEmail(this.database.db, {
      userId: auth.userId,
      signInCode: body.signInCode,
      secret: this.config.AUTH_CODE_SECRET,
    });
    if (outcome !== 'removed')
      throw new CodedHttpException(400, 'CODE_INVALID');
    return { data: { removed: true } };
  }

  /** Always 202: never reveals which addresses have accounts or recovery emails. */
  @Post('auth/email-recovery/start')
  @HttpCode(202)
  @RateLimit('auth_code')
  async start(
    @Body(new ZodValidationPipe(emailRecoveryStartSchema))
    body: z.infer<typeof emailRecoveryStartSchema>,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    await startEmailRecovery(this.database.db, this.sealing, {
      signInEmail: body.email,
      secret: this.config.AUTH_CODE_SECRET,
    });
    return { data: { sent: true } };
  }

  @Post('auth/email-recovery/propose')
  @HttpCode(202)
  @RateLimit('auth_verify')
  async propose(
    @Body(new ZodValidationPipe(emailRecoveryProposeSchema))
    body: z.infer<typeof emailRecoveryProposeSchema>,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    const outcome = await proposeRecoveredEmail(
      this.database.db,
      this.sealing,
      {
        signInEmail: body.email,
        recoveryCode: body.code,
        newEmail: body.newEmail,
        secret: this.config.AUTH_CODE_SECRET,
      },
    );
    if (outcome === 'bad_new_email')
      throw new CodedHttpException(400, 'EMAIL_INVALID');
    if (outcome === 'new_email_busy')
      throw new CodedHttpException(429, 'TOO_MANY_CODES');
    if (outcome !== 'code_sent')
      throw new CodedHttpException(400, 'CODE_INVALID');
    return { data: { sent: true } };
  }

  @Post('auth/email-recovery/confirm')
  @HttpCode(200)
  @RateLimit('auth_verify')
  async confirmRecovery(
    @Body(new ZodValidationPipe(emailRecoveryConfirmSchema))
    body: z.infer<typeof emailRecoveryConfirmSchema>,
  ): Promise<ApiDataResponse<{ effectiveAt: string }>> {
    const result = await confirmRecoveredEmail(this.database.db, this.sealing, {
      signInEmail: body.email,
      newEmail: body.newEmail,
      code: body.code,
      secret: this.config.AUTH_CODE_SECRET,
    });
    if (result.status === 'taken')
      throw new CodedHttpException(409, 'EMAIL_TAKEN');
    if (result.status !== 'pending')
      throw new CodedHttpException(400, 'CODE_INVALID');
    return { data: { effectiveAt: result.effectiveAt.toISOString() } };
  }
}
