import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { SharesEnabledGuard } from './release2-flags.guard.js';
/**
 * Owned by lane R2-C1 (feat/business-share-agree): propose, answer and report a share: `/v1/me/businesses/:id/shares*`, `/v1/me/work/shares*`, `/v1/me/work/:memberId/report-business`.
 * Registered by R2-0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard, SharesEnabledGuard)
export class ShareAgreementsController {}
