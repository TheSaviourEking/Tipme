import { Controller, UseGuards } from '@nestjs/common';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { SharesEnabledGuard } from './release2-flags.guard.js';
/**
 * Owned by lane R2-B (feat/business-payouts): a business's balance, payout destination and withdrawals: `/v1/me/businesses/:id/balance`, `…/payout-destination`, `…/withdrawals` (owners only).
 * Registered by R2-0 so lanes never collide in the module; routes are added here only by that lane.
 */
@Controller('v1')
@UseGuards(BusinessEnabledGuard, SharesEnabledGuard)
export class BusinessPayoutsController {}
