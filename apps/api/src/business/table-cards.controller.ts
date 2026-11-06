import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';

/**
 * Owned by lane R2-E (feat/business-tables): table cards: `/v1/me/businesses/:id/locations/:locationId/tables*` and the card URL.
 * Registered by R2-0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard)
export class TableCardsController {}
