import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { ProfilesModule } from '../profiles/profiles.module.js';
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

/**
 * TipMe for businesses (plan 2026-11-06-business). Behind `BUSINESS_ENABLED`. Every lane's controller
 * is registered here by B0, so a lane changes only its own controller file.
 */
@Module({
  // ProfileRevalidator: shift changes refresh the business's public pages (B6).
  imports: [ProfilesModule],
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
  ],
  providers: [BusinessEnabledGuard, SessionGuard, CsrfGuard, RateLimitGuard],
  exports: [BusinessEnabledGuard],
})
export class BusinessModule {}
