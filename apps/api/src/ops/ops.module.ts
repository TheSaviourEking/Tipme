import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { OpsAccessController } from './ops-access.controller.js';
import { OpsIssuesController } from './issues.controller.js';
import { OpsActionsController } from './actions.controller.js';
import { OpsPayoutIssuesController } from './payout-issues.controller.js';
import { OpsMetricsController } from './metrics.controller.js';
import { OpsPagesController } from './pages.controller.js';
import { OpsSearchController } from './search.controller.js';
import { OpsMarketController } from './market.controller.js';
import { OpsAccountRecoveryController } from './account-recovery.controller.js';
import { OpsEmailConsoleController } from './email-console.controller.js';
import { OpsProvidersController } from './providers.controller.js';
import { OpsStaffController } from './staff.controller.js';
import { OpsApprovalsController } from './approvals.controller.js';
import { MailModule } from '../mail/mail.module.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { FreshCodeGuard } from './fresh-code.guard.js';
import { OpsGuard, StaffGuard } from './ops.guard.js';

/** The staff admin area (PR-009). */
@Module({
  imports: [CheckoutModule, ProfilesModule, MailModule],
  controllers: [
    OpsAccessController,
    OpsIssuesController,
    OpsActionsController,
    OpsPayoutIssuesController,
    OpsMetricsController,
    OpsMarketController,
    OpsPagesController,
    OpsSearchController,
    OpsProvidersController,
    OpsStaffController,
    OpsApprovalsController,
    OpsEmailConsoleController,
    OpsAccountRecoveryController,
  ],
  providers: [CsrfGuard, RateLimitGuard, StaffGuard, OpsGuard, FreshCodeGuard],
})
export class OpsModule {}
