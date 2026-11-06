import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * Owned by lane B8 (feat/business-codes): location and staff codes: `/v1/me/businesses/:id/codes`.
 * Registered by B0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class BusinessCodesController {}
