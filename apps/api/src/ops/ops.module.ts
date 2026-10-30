import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { OpsAccessController } from './ops-access.controller.js';
import { OpsIssuesController } from './issues.controller.js';
import { OpsActionsController } from './actions.controller.js';
import { OpsMetricsController } from './metrics.controller.js';
import { OpsPagesController } from './pages.controller.js';
import { OpsSearchController } from './search.controller.js';
import { OpsMarketController } from './market.controller.js';
import { OpsProvidersController } from './providers.controller.js';
import { MailModule } from '../mail/mail.module.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
import { OpsGuard, StaffGuard } from './ops.guard.js';

/** The staff admin area (PR-009). */
@Module({
  imports: [CheckoutModule, ProfilesModule, MailModule],
  controllers: [
    OpsAccessController,
    OpsIssuesController,
    OpsActionsController,
    OpsMetricsController,
    OpsMarketController,
    OpsPagesController,
    OpsSearchController,
    OpsProvidersController,
  ],
  providers: [CsrfGuard, RateLimitGuard, StaffGuard, OpsGuard],
})
export class OpsModule {}
