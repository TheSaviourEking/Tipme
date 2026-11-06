import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from '../business/business-enabled.guard.js';

/**
 * TipMe for businesses, owned by lane B5 (feat/business-notes): reveal and review a reported note: `/v1/ops/business-notes/:tipId/*`.
 * Registered by B0 so lanes never collide in the module; routes are added here only by that lane,
 * each with its `@OpsPermission`.
 */
@Controller('v1/ops')
@UseGuards(BusinessEnabledGuard)
export class OpsBusinessNotesController {}
