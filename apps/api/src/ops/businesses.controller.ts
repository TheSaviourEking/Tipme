import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from '../business/business-enabled.guard.js';

/**
 * TipMe for businesses, owned by lane B2 (feat/business-ops): list, detail, masked contacts and reveal, `business.verify`, suspend and restore: `/v1/ops/businesses`.
 * Registered by B0 so lanes never collide in the module; routes are added here only by that lane,
 * each with its `@OpsPermission`.
 */
@Controller('v1/ops')
@UseGuards(BusinessEnabledGuard)
export class OpsBusinessesController {}
