import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { OpsAccessController } from './ops-access.controller.js';
import { OpsIssuesController } from './issues.controller.js';
import { OpsActionsController } from './actions.controller.js';
import { OpsPayoutIssuesController } from './payout-issues.controller.js';
import { OpsMetricsController } from './metrics.controller.js';
import { OpsPagesController } from './pages.controller.js';
import { OpsDatabaseBudgetController } from './database-budget.controller.js';
import { OpsWithdrawalsSwitchController } from './withdrawals-switch.controller.js';
import { OpsSearchController } from './search.controller.js';
import { OpsMarketController } from './market.controller.js';
import { OpsAccountRecoveryController } from './account-recovery.controller.js';
import { OpsEmailConsoleController } from './email-console.controller.js';
import { OpsProvidersController } from './providers.controller.js';
import { OpsStaffController } from './staff.controller.js';
import { OpsApprovalsController } from './approvals.controller.js';
import { OpsUsernamesController } from './usernames.controller.js';
import { OpsBusinessesController } from './businesses.controller.js';
import { OpsBusinessNotesController } from './business-notes.controller.js';
import { BusinessEnabledGuard } from '../business/business-enabled.guard.js';
import { OpsChangelogController } from './changelog.controller.js';
import { OpsProPaymentsController } from './pro-payments.controller.js';
import { OpsProPriceController } from './pro-price.controller.js';
import { OpsSwitchesController } from './switches.controller.js';
import { MailModule } from '../mail/mail.module.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { FreshCodeGuard } from './fresh-code.guard.js';
import { OpsGuard, StaffGuard } from './ops.guard.js';
import { seriousServicesProvider } from './serious-services.js';

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
    OpsWithdrawalsSwitchController,
    OpsDatabaseBudgetController,
    OpsSearchController,
    OpsProvidersController,
    OpsStaffController,
    OpsApprovalsController,
    OpsEmailConsoleController,
    OpsAccountRecoveryController,
    OpsUsernamesController,
    // TipMe for businesses: B2 and B5 fill these.
    OpsBusinessesController,
    OpsBusinessNotesController,
    OpsChangelogController,
    OpsProPriceController,
    OpsProPaymentsController,
    OpsSwitchesController,
  ],
  providers: [
    CsrfGuard,
    RateLimitGuard,
    StaffGuard,
    OpsGuard,
    FreshCodeGuard,
    seriousServicesProvider,
    BusinessEnabledGuard,
  ],
})
export class OpsModule {}
