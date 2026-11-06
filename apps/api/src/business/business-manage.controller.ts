import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * Owned by lane B1 (feat/business-setup): apply, edit, locations and managers: `/v1/me/businesses`, `/v1/me/businesses/:id`, `…/locations`, `…/managers`.
 * Registered by B0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class BusinessManageController {}
