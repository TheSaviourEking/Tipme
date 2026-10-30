import { createHash, randomBytes } from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  signInCodeRequestSchema,
  signInVerifySchema,
  type ApiDataResponse,
  type SessionView,
  type SignInCodeRequest,
  type SignInVerified,
  type SignInVerifyRequest,
} from '@tipme/contracts';
import {
  createSession,
  hasProfile,
  listSessions,
  activeMailProvider,
  mailSealing,
  requestEmailSignInCode,
  requestSignInCode,
  type MailSealing,
  verifyEmailSignInCode,
  resolveSession,
  revokeAllSessions,
  revokeSession,
  verifySignInCode,
} from '@tipme/database';
import type { Request, Response } from 'express';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import {
  clearSessionCookie,
  DEVICE_COOKIE,
  readCookie,
  SESSION_COOKIE,
  setDeviceCookie,
  setSessionCookie,
} from './cookies.js';
import { CsrfGuard } from './csrf.guard.js';
import {
  CurrentUser,
  SessionGuard,
  type AuthContext,
} from './session.guard.js';

/** Recipient sign-in with an email and a one-time code (ADR-0003, ADR-0017). */
@Controller('v1')
@UseGuards(CsrfGuard)
export class AuthController {
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {
    this.sealing = mailSealing(Buffer.from(config.MAIL_SEAL_KEY, 'base64'));
  }

  private readonly sealing: MailSealing;

  /** Phone codes aren't built yet: phone sign-in exists only while messaging is pretend. */
  private async assertPhoneAllowed(): Promise<void> {
    const active = await activeMailProvider(
      this.database.db,
      this.config.MAIL_DEFAULT_PROVIDER,
    );
    if (active !== 'mock') throw new CodedHttpException(404, 'NOT_FOUND');
  }

  /** Always 202: the answer never reveals whether the address has an account. */
  @Post('auth/code')
  @HttpCode(202)
  @RateLimit('auth_code')
  async code(
    @Body(new ZodValidationPipe(signInCodeRequestSchema))
    body: SignInCodeRequest,
  ): Promise<ApiDataResponse<{ sent: true }>> {
    if ('email' in body) {
      await requestEmailSignInCode(this.database.db, this.sealing, {
        email: body.email,
        secret: this.config.AUTH_CODE_SECRET,
        codesPerHour: this.config.RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR,
      });
      return { data: { sent: true } };
    }
    await this.assertPhoneAllowed();
    await requestSignInCode(this.database.db, {
      phone: body.phone,
      secret: this.config.AUTH_CODE_SECRET,
      codesPerHour: this.config.RATE_LIMIT_CODES_PER_NUMBER_PER_HOUR,
    });
    return { data: { sent: true } };
  }

  @Post('auth/verify')
  @HttpCode(200)
  @RateLimit('auth_verify')
  async verify(
    @Body(new ZodValidationPipe(signInVerifySchema)) body: SignInVerifyRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<SignInVerified>> {
    const { db } = this.database;
    // Set on the first sign-in from this browser; only its hash is stored.
    const device =
      readCookie(request, DEVICE_COOKIE) ??
      randomBytes(32).toString('base64url');
    const deviceHash = createHash('sha256').update(device).digest('hex');
    if (!('email' in body)) await this.assertPhoneAllowed();
    const result =
      'email' in body
        ? await verifyEmailSignInCode(db, this.sealing, {
            email: body.email,
            code: body.code,
            secret: this.config.AUTH_CODE_SECRET,
            deviceHash,
            ...(body.deviceLabel ? { deviceLabel: body.deviceLabel } : {}),
            webOrigin: this.config.WEB_ORIGIN,
          })
        : await verifySignInCode(db, {
            phone: body.phone,
            code: body.code,
            secret: this.config.AUTH_CODE_SECRET,
          });
    if (result.status === 'locked')
      throw new CodedHttpException(429, 'SIGN_IN_LOCKED');
    if (result.status === 'pending_recovery')
      throw new CodedHttpException(409, 'RECOVERY_PENDING');
    if (result.status !== 'ok')
      throw new CodedHttpException(400, 'CODE_INVALID');
    // A new sign-in always gets a new token; any session this browser held is ended.
    const previous = readCookie(request, SESSION_COOKIE);
    const old = previous
      ? await resolveSession(db, previous, new Date())
      : null;
    if (old)
      await revokeSession(db, { userId: old.userId, sessionId: old.sessionId });
    const session = await createSession(db, {
      userId: result.userId,
      deviceLabel: body.deviceLabel ?? 'Browser',
      deviceHash,
    });
    setSessionCookie(response, this.config, session.token, session.expiresAt);
    setDeviceCookie(response, this.config, device);
    return {
      data: {
        userId: result.userId,
        isNew: result.created,
        hasProfile: await hasProfile(db, result.userId),
      },
    };
  }

  @Post('auth/sign-out')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async signOut(
    @CurrentUser() auth: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await revokeSession(this.database.db, auth);
    clearSessionCookie(response, this.config);
  }

  @Get('me/sessions')
  @UseGuards(SessionGuard)
  async sessions(
    @CurrentUser() auth: AuthContext,
  ): Promise<ApiDataResponse<SessionView[]>> {
    const sessions = await listSessions(this.database.db, auth.userId);
    return {
      data: sessions.map((session) => ({
        id: session.id,
        deviceLabel: session.deviceLabel,
        createdAt: session.createdAt.toISOString(),
        lastSeenAt: session.lastSeenAt.toISOString(),
        current: session.id === auth.sessionId,
      })),
    };
  }

  @Delete('me/sessions/:id')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async revoke(
    @CurrentUser() auth: AuthContext,
    @Param('id') id: string,
  ): Promise<void> {
    if (!/^[0-9a-f-]{36}$/.test(id)) return;
    await revokeSession(this.database.db, {
      userId: auth.userId,
      sessionId: id,
    });
  }

  @Post('me/sessions/sign-out-others')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async signOutOthers(@CurrentUser() auth: AuthContext): Promise<void> {
    await revokeAllSessions(this.database.db, {
      userId: auth.userId,
      exceptSessionId: auth.sessionId,
    });
  }
}
