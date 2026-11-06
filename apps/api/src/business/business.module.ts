import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { MailModule } from '../mail/mail.module.js';
import { BusinessEnabledGuard } from './business-enabled.guard.js';
import { BusinessRolesController } from './business-roles.controller.js';
import { BusinessManageController } from './business-manage.controller.js';
import { BusinessMembersController } from './business-members.controller.js';
import { WorkController } from './work.controller.js';
import { BusinessPublicController } from './business-public.controller.js';
import { BusinessNotesController } from './business-notes.controller.js';
import { BusinessShiftsController } from './business-shifts.controller.js';
import { BusinessInsightsController } from './business-insights.controller.js';
import { BusinessCodesController } from './business-codes.controller.js';
import { ShareAgreementsController } from './share-agreements.controller.js';
import { TeamTipsController } from './team-tips.controller.js';
import { TableCardsController } from './table-cards.controller.js';
import { BusinessPayoutsController } from './business-payouts.controller.js';
import {
  SharesEnabledGuard,
  TeamTipsEnabledGuard,
} from './release2-flags.guard.js';

/**
 * TipMe for businesses (plan 2026-11-06-business). Behind `BUSINESS_ENABLED`. Every lane's controller
 * is registered here by B0, so a lane changes only its own controller file.
 */
@Module({
  // R2-B: a business's withdrawals use the person's payout provider and mail sealing.
  imports: [CheckoutModule, MailModule],
  controllers: [
    BusinessRolesController,
    BusinessManageController,
    BusinessMembersController,
    WorkController,
    BusinessPublicController,
    BusinessNotesController,
    BusinessShiftsController,
    BusinessInsightsController,
    BusinessCodesController,
    // Release 2 (R2-0).
    ShareAgreementsController,
    TeamTipsController,
    TableCardsController,
    BusinessPayoutsController,
  ],
  providers: [
    BusinessEnabledGuard,
    SharesEnabledGuard,
    TeamTipsEnabledGuard,
    SessionGuard,
    CsrfGuard,
    RateLimitGuard,
  ],
  exports: [BusinessEnabledGuard],
})
export class BusinessModule {}
