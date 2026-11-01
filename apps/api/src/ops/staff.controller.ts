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
} from '@nestjs/common';
import {
  opsChangeRoleSchema,
  opsPersonalAccessSchema,
  opsReasonSchema,
  opsRoleCreateSchema,
  opsRoleImpactSchema,
  opsRoleUpdateSchema,
  type ApiDataResponse,
  type OpsChangeRoleRequest,
  type OpsEffectiveAccess,
  type OpsPersonalAccessRequest,
  type OpsReasonRequest,
  type OpsRole,
  type OpsRoleCreateRequest,
  type OpsRoleImpact,
  type OpsRoleImpactRequest,
  type OpsRoleUpdateRequest,
  type OpsRoleUpdated,
} from '@tipme/contracts';
import {
  changeRole,
  createRole,
  deleteRole,
  effectiveAccess,
  listRoles,
  OperationError,
  roleImpact,
  setPersonalAccess,
  updateRole,
} from '@tipme/database';
import { ZodValidationPipe } from '../http/zod-validation.pipe.js';
import { DatabaseProvider } from '../infra/database.js';
import { uuidParam } from './actions.controller.js';
import { CurrentOps, type OpsContext } from './ops.guard.js';
import { OpsPermission } from './permission.decorator.js';

/**
 * Custom roles and per-person access. The operations hold every authorisation rule and re-check
 * the actor, so this only passes the signed-in staff member through.
 */
@Controller('v1/ops/staff')
export class OpsStaffController {
  constructor(
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  @Get('roles')
  @OpsPermission('staff.manage')
  async roles(): Promise<ApiDataResponse<OpsRole[]>> {
    return { data: await listRoles(this.database.db) };
  }

  @Post('roles')
  @HttpCode(201)
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
  @OpsPermission('staff.manage')
  async update(
    @CurrentOps() ops: OpsContext,
    @Param('roleId') roleId: string,
    @Body(new ZodValidationPipe(opsRoleUpdateSchema))
    body: OpsRoleUpdateRequest,
  ): Promise<ApiDataResponse<OpsRoleUpdated>> {
    const { name, description, permissions, reason } = body;
    return {
      data: await updateRole(this.database.db, {
        actorId: ops.userId,
        roleId,
        reason,
        ...(name === undefined ? {} : { name }),
        ...(description === undefined ? {} : { description }),
        ...(permissions === undefined ? {} : { permissions }),
      }),
    };
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
  @OpsPermission('staff.manage')
  async setAccess(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsPersonalAccessSchema))
    body: OpsPersonalAccessRequest,
  ): Promise<ApiDataResponse<OpsEffectiveAccess>> {
    return {
      data: await setPersonalAccess(this.database.db, {
        ...body,
        actorId: ops.userId,
        userId: uuidParam(userId),
      }),
    };
  }

  @Put(':userId/role')
  @OpsPermission('staff.manage')
  async setRole(
    @CurrentOps() ops: OpsContext,
    @Param('userId') userId: string,
    @Body(new ZodValidationPipe(opsChangeRoleSchema))
    body: OpsChangeRoleRequest,
  ): Promise<ApiDataResponse<OpsEffectiveAccess>> {
    return {
      data: await changeRole(this.database.db, {
        ...body,
        actorId: ops.userId,
        userId: uuidParam(userId),
      }),
    };
  }
}
