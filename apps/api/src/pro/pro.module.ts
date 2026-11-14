import { Module } from '@nestjs/common';
import { CsrfGuard } from '../auth/csrf.guard.js';
import { SessionGuard } from '../auth/session.guard.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { MailModule } from '../mail/mail.module.js';
import { ProController } from './pro.controller.js';
import { proCheckoutProvider, PRO_CHECKOUT_TOKEN } from './pro-provider.js';

/** Paid Pro (ADR-0015): buying a month, and reading the page's Pro. */
@Module({
  imports: [CheckoutModule, MailModule],
  controllers: [ProController],
  providers: [SessionGuard, CsrfGuard, proCheckoutProvider],
  exports: [PRO_CHECKOUT_TOKEN],
})
export class ProModule {}
