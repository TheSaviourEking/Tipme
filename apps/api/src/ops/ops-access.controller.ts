import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  opsCodeSchema,
  opsEnrolSchema,
  type ApiDataResponse,
  type OpsAuditEntry,
  type OpsCodeRequest,
  type OpsEnrolment,
  type OpsEnrolRequest,
  type OpsMe,
} from '@tipme/contracts';
import {
  confirmEnrolmentAndOpenGrant,
  listAudit,
  openOpsGrant,
  opsEnrolmentState,
  resolveOpsGrant,
  revokeOpsGrants,
  staffRole,
  startTotpEnrolment,
  type OpenGrantResult,
} from '@tipme/database';
import type { Response } from 'express';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import {
  clearOpsCookie,
  OPS_COOKIE,
  readCookie,
  setOpsCookie,
} from '../auth/cookies.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { CurrentUser, type AuthContext } from '../auth/session.guard.js';
import { CodedHttpException } from '../http/coded.exception.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import {
  CurrentOps,
  StaffGuard,
  type OpsContext,
  type OpsRequest,
} from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/** Staff sign-in step (authenticator), the audit log and the admin's own role (ADR-0010). */
@Controller('v1/ops')
export class OpsAccessController {
  private readonly key: Buffer;
  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {
    this.key = Buffer.from(config.OPS_TOTP_KEY, 'base64');
  }

  /** Staff only (others 404): which step comes next, or the role once a grant is open. */
  @Get('me')
  @UseGuards(StaffGuard)
  async me(
    @CurrentUser() auth: AuthContext,
    @Req() request: OpsRequest,
  ): Promise<ApiDataResponse<OpsMe>> {
    const token = readCookie(request, OPS_COOKIE);
    const grant = token
      ? await resolveOpsGrant(this.database.db, {
          token,
          sessionId: auth.sessionId,
        })
      : null;
    if (grant) {
      const role = (await staffRole(this.database.db, grant.userId)) ?? '';
      return {
        data: {
          state: 'granted',
          role,
          permissions: [...grant.permissions].sort(),
        },
      };
    }
    const state = await opsEnrolmentState(this.database.db, auth.userId);
    return {
      data: { state: state === 'enrolled' ? 'needs_code' : 'needs_enrolment' },
    };
  }

  @Post('enrol')
  @HttpCode(200)
  @UseGuards(CsrfGuard, StaffGuard)
  @RateLimit('auth_verify')
  async enrol(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(opsEnrolSchema)) body: OpsEnrolRequest,
  ): Promise<ApiDataResponse<OpsEnrolment>> {
    return {
      data: await startTotpEnrolment(this.database.db, {
        userId: auth.userId,
        enrolmentCode: body.enrolmentCode,
        key: this.key,
      }),
    };
  }

  @Post('enrol/confirm')
  @HttpCode(200)
  @UseGuards(CsrfGuard, StaffGuard)
  @RateLimit('auth_verify')
  async confirm(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(opsCodeSchema)) body: OpsCodeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<{ expiresAt: string }>> {
    return this.granted(
      response,
      await confirmEnrolmentAndOpenGrant(this.database.db, {
        ...auth,
        code: body.code,
        key: this.key,
      }),
    );
  }

  @Post('grant')
  @HttpCode(200)
  @UseGuards(CsrfGuard, StaffGuard)
  @RateLimit('auth_verify')
  async grant(
    @CurrentUser() auth: AuthContext,
    @Body(new ZodValidationPipe(opsCodeSchema)) body: OpsCodeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<{ expiresAt: string }>> {
    return this.granted(
      response,
      await openOpsGrant(this.database.db, {
        ...auth,
        code: body.code,
        key: this.key,
      }),
    );
  }

  @Post('sign-out')
  @HttpCode(204)
  @UseGuards(CsrfGuard, StaffGuard)
  async signOut(
    @CurrentUser() auth: AuthContext,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await revokeOpsGrants(this.database.db, auth.userId);
    clearOpsCookie(response, this.config);
  }

  @Get('audit')
  @OpsPermission('audit.view')
  async audit(
    @CurrentOps() _ops: OpsContext,
    @Query('cursor') cursor?: string,
  ): Promise<ApiDataResponse<OpsAuditEntry[]>> {
    const parsed =
      cursor && /^\d{1,15}$/.test(cursor) ? Number(cursor) : undefined;
    return {
      data: await listAudit(this.database.db, { cursor: parsed, limit: 50 }),
    };
  }

  private granted(
    response: Response,
    result: OpenGrantResult,
  ): ApiDataResponse<{ expiresAt: string }> {
    if (result.status === 'ok') {
      setOpsCookie(response, this.config, result.token, result.expiresAt);
      return { data: { expiresAt: result.expiresAt.toISOString() } };
    }
    if (result.status === 'locked')
      throw new CodedHttpException(429, 'OPS_LOCKED');
    if (result.status === 'not_staff')
      throw new CodedHttpException(404, 'NOT_FOUND');
    throw new CodedHttpException(400, 'CODE_INVALID');
  }
}
