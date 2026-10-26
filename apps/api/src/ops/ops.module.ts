import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { OpsAccessController } from './ops-access.controller.js';
import { OpsAccountsController } from './accounts.controller.js';
import { OpsIssuesController } from './issues.controller.js';
import { OpsActionsController } from './actions.controller.js';
import { OpsMetricsController } from './metrics.controller.js';
import { OpsMarketController } from './market.controller.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { OpsGuard, StaffGuard } from './ops.guard.js';

/** The staff admin area (PR-009). */
@Module({
  imports: [CheckoutModule, ProfilesModule],
  controllers: [
    OpsAccessController,
    OpsIssuesController,
    OpsActionsController,
    OpsMetricsController,
    OpsMarketController,
    OpsAccountsController,
  ],
  providers: [CsrfGuard, RateLimitGuard, StaffGuard, OpsGuard],
})
export class OpsModule {}
