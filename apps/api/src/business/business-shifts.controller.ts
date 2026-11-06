import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * Owned by lane B6 (feat/business-shifts): check in and out: `/v1/me/work/:memberId/shift/*`, `/v1/me/businesses/:id/members/:memberId/shift/*`.
 * Registered by B0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class BusinessShiftsController {}
