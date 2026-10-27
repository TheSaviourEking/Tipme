import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import {
  BACHS_PROVIDER_TOKEN,
  bachsProviderProvider,
  CHECKOUT_PROVIDER_TOKEN,
  checkoutProviderProvider,
  PAYMENT_PROVIDER_TOKEN,
  paymentProviderProvider,
} from './payment-provider.provider.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { StatusController } from './status.controller.js';

@Module({
  controllers: [CheckoutController, StatusController],
  providers: [
    CheckoutService,
    RateLimitGuard,
    paymentProviderProvider,
    bachsProviderProvider,
    checkoutProviderProvider,
  ],
  exports: [
    CheckoutService,
    PAYMENT_PROVIDER_TOKEN,
    BACHS_PROVIDER_TOKEN,
    CHECKOUT_PROVIDER_TOKEN,
  ],
})
export class CheckoutModule {}
