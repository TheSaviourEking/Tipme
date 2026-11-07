import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { TeamTipsEnabledGuard } from './release2-flags.guard.js';
/**
 * Owned by lane R2-D (feat/business-team-tip): tip the whole team: `/v1/b/:business/:location/team-quote`, `/v1/team-tip-intents` (public, rate-limited).
 * Registered by R2-0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard, TeamTipsEnabledGuard)
export class TeamTipsController {}
