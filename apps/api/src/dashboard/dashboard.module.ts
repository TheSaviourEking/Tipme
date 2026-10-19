import { Module } from '@nestjs/common';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { DashboardController } from './dashboard.controller.js';

@Module({
  imports: [CheckoutModule],
  controllers: [DashboardController],
  providers: [SessionGuard, CsrfGuard],
})
export class DashboardModule {}
