import { Module } from '@nestjs/common';
import { ServerEvents } from '../analytics/server-events.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DashboardController } from './dashboard.controller.js';

@Module({
  imports: [CheckoutModule],
  controllers: [DashboardController],
  providers: [SessionGuard, CsrfGuard, ServerEvents],
})
export class DashboardModule {}
