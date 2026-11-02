import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  opsAddStaffSchema,
  opsChangeRoleSchema,
  opsPersonalAccessSchema,
  opsReasonSchema,
  opsRoleCreateSchema,
  opsRoleImpactSchema,
  opsRoleUpdateSchema,
  type ApiDataResponse,
  type OpsAddStaffRequest,
  type OpsChangeRoleRequest,
  type OpsEffectiveAccess,
  type OpsEnrolmentLinkSent,
  type OpsPersonalAccessRequest,
  type OpsReasonRequest,
  type OpsRole,
  type OpsRoleCreateRequest,
  type OpsRoleImpact,
  type OpsRoleImpactRequest,
  type OpsRoleUpdateRequest,
  type OpsRoleUpdated,
  type OpsSeriousPending,
  type OpsStaffAdded,
  type OpsStaffPerson,
} from '@tipme/contracts';
import {
  activeStaffList,
  addStaffOrAsk,
  changeRoleOrAsk,
  createRole,
  deleteRole,
  effectiveAccess,
  listRoles,
  type MailSealing,
  OperationError,
  removeStaff,
  resendInvitation,
  requestSeriousAction,
  type SeriousActionServices,
  roleImpact,
  setPersonalAccessOrAsk,
  updateRoleOrAsk,
} from '@tipme/database';
import { RateLimit } from '../checkout/rate-limit.guard.js';
import { pendingOr, SERIOUS_SERVICES } from './serious-services.js';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { MAIL_SEALING } from '../mail/mail-providers.provider.js';
import { uuidParam } from './actions.controller.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { FreshCode } from './fresh-code.guard.js';
import { OpsPermission } from './permission.decorator.js';

/**
 * People, custom roles and per-person access. The operations hold every authorisation rule and re-check
 * the actor, so this only passes the signed-in staff member through.
 */
@Controller('v1/ops/staff')
export class OpsStaffController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(MAIL_SEALING) private readonly sealing: MailSealing,
    @Inject(SERIOUS_SERVICES) private readonly services: SeriousActionServices,
  ) {}

  private asking(ops: OpsContext) {
    return {
      actorId: ops.userId,
      grantId: ops.grantId,
      services: this.services,
    };
  }

  @Get()
  @FreshCode()
  @OpsPermission('staff.manage')
  async people(): Promise<ApiDataResponse<OpsStaffPerson[]>> {
    return { data: await activeStaffList(this.database.db) };
  }

  @Post()
  @HttpCode(201)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('staff.manage')
  async addPerson(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsAddStaffSchema)) body: OpsAddStaffRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<OpsStaffAdded | OpsSeriousPending>> {
    const answer = pendingOr<OpsStaffAdded>(
      await addStaffOrAsk(this.database.db, {
        ...body,
        ...this.asking(ops),
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }

  @Post(':userId/remove')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('staff.manage')
  async removePerson(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ removed: true }>> {
    await removeStaff(this.database.db, {
      ...body,
      actorId: ops.userId,
      userId: uuidParam(userId),
      sealing: this.sealing,
    });
    return { data: { removed: true } };
  }

  @Post(':userId/resend-invitation')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('staff.manage')
  async resendPersonInvitation(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<OpsEnrolmentLinkSent>> {
    return {
      data: await resendInvitation(this.database.db, {
        ...body,
        actorId: ops.userId,
        userId: uuidParam(userId),
        sealing: this.sealing,
      }),
    };
  }

  @Post(':userId/reset-authenticator')
  @HttpCode(200)
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('staff.manage')
  async resetPersonAuthenticator(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<OpsEnrolmentLinkSent | OpsSeriousPending>> {
    const answer = pendingOr<OpsEnrolmentLinkSent>(
      await requestSeriousAction(this.database.db, {
        name: 'staff.reset_authenticator',
        payload: { userId: uuidParam(userId) },
        reason: body.reason,
        ...this.asking(ops),
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }

  @Get('roles')
  @OpsPermission('staff.manage')
  async roles(): Promise<ApiDataResponse<OpsRole[]>> {
    return { data: await listRoles(this.database.db) };
  }

  @Post('roles')
  @HttpCode(201)
  @FreshCode()
  @OpsPermission('staff.manage')
  async create(
    @CurrentOps() ops: OpsContext,
    @Body(new ZodValidationPipe(opsRoleCreateSchema))
    body: OpsRoleCreateRequest,
  ): Promise<ApiDataResponse<OpsRole>> {
    return {
      data: await createRole(this.database.db, {
        ...body,
        actorId: ops.userId,
      }),
    };
  }

  @Patch('roles/:roleId')
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('staff.manage')
  async update(
    @CurrentOps() ops: OpsContext,
    @Param('roleId') roleId: string,
    @Body(new ZodValidationPipe(opsRoleUpdateSchema))
    body: OpsRoleUpdateRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<OpsRoleUpdated | OpsSeriousPending>> {
    const { name, description, permissions, reason } = body;
    const answer = pendingOr<OpsRoleUpdated>(
      await updateRoleOrAsk(this.database.db, {
        ...this.asking(ops),
        roleId,
        reason,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(permissions === undefined ? {} : { permissions }),
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }

  /** The dry run behind "who is affected": changes nothing. */
  @Post('roles/:roleId/impact')
  @HttpCode(200)
  @OpsPermission('staff.manage')
  async impact(
    @Param('roleId') roleId: string,
    @Body(new ZodValidationPipe(opsRoleImpactSchema))
    body: OpsRoleImpactRequest,
  ): Promise<ApiDataResponse<OpsRoleImpact>> {
    return {
      data: await roleImpact(this.database.db, {
        roleId,
        permissions: body.permissions,
      }),
    };
  }

  @Post('roles/:roleId/delete')
  @HttpCode(200)
  @FreshCode()
  @OpsPermission('staff.manage')
  async remove(
    @CurrentOps() ops: OpsContext,
    @Param('roleId') roleId: string,
    @Body(new ZodValidationPipe(opsReasonSchema)) body: OpsReasonRequest,
  ): Promise<ApiDataResponse<{ deleted: true }>> {
    await deleteRole(this.database.db, {
      actorId: ops.userId,
      roleId,
      reason: body.reason,
    });
    return { data: { deleted: true } };
  }

  @Get(':userId/access')
  @OpsPermission('staff.manage')
  async access(
    @Param('userId') userId: string,
  ): Promise<ApiDataResponse<OpsEffectiveAccess>> {
    const access = await effectiveAccess(this.database.db, uuidParam(userId));
    if (!access) throw new OperationError('STAFF_NOT_FOUND');
    return { data: access };
  }

  @Put(':userId/access')
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('staff.manage')
  async setAccess(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsPersonalAccessSchema))
    body: OpsPersonalAccessRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<OpsEffectiveAccess | OpsSeriousPending>> {
    const answer = pendingOr<OpsEffectiveAccess>(
      await setPersonalAccessOrAsk(this.database.db, {
        ...body,
        ...this.asking(ops),
        userId: uuidParam(userId),
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }

  @Put(':userId/role')
  @RateLimit('ops_request')
  @FreshCode()
  @OpsPermission('staff.manage')
  async setRole(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsChangeRoleSchema))
    body: OpsChangeRoleRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiDataResponse<OpsEffectiveAccess | OpsSeriousPending>> {
    const answer = pendingOr<OpsEffectiveAccess>(
      await changeRoleOrAsk(this.database.db, {
        ...body,
        ...this.asking(ops),
        userId: uuidParam(userId),
      }),
      response,
    );
    return { data: 'pending' in answer ? answer.pending : answer.result };
  }
}
