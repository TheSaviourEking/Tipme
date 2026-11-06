import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * Owned by lane B5 (feat/business-notes): the supporter's note (status token) and reports: `/v1/tips/:tipId/business-note`, `/v1/me/work/notes`, `…/notes/:tipId/report`.
 * Registered by B0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class BusinessNotesController {}
