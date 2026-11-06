import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * Owned by lane B4 (feat/business-public): public, rate-limited reads: `/v1/b/:business/:location`, `/v1/b/:business/people`, `/v1/b/:business/:location/:handle`.
 * Registered by B0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class BusinessPublicController {}
