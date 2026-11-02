import { applyDecorators, SetMetadata, UseGuards } from '@nestjs/common';
import type { OpsPermission as Permission } from '@tipme/database';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { OPS_ANY_STAFF, OPS_PERMISSION, OpsGuard } from './ops.guard.js';

/**
 * Every admin route names its permission; the guard checks it on the server. A route that serves one
 * screen may name several, when each of them is useless without reading that screen: holding any opens it.
 */
export const OpsPermission = (first: Permission, ...others: Permission[]) =>
  applyDecorators(
    SetMetadata(OPS_PERMISSION, others.length ? [first, ...others] : first),
    UseGuards(CsrfGuard, OpsGuard),
  );

/**
 * For routes that serve records under many permissions (an approval needs the one its action names).
 * Signed-in staff with a live grant get through; THE OPERATION MUST DO THE AUTHORISING.
 */
export const OpsAnyStaff = () =>
  applyDecorators(
    SetMetadata(OPS_ANY_STAFF, true),
    UseGuards(CsrfGuard, OpsGuard),
  );
