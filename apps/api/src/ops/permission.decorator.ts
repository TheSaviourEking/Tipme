import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { OpsPermission as Permission } from '@tipme/database';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { OPS_PERMISSION, OpsGuard } from './ops.guard.js';

/** Every admin route names exactly one permission; the guard checks it on the server. */
export const OpsPermission = (permission: Permission) =>
  applyDecorators(
    SetMetadata(OPS_PERMISSION, permission),
    UseGuards(CsrfGuard, OpsGuard),
  );
