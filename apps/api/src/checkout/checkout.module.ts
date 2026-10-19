import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import {
  PAYMENT_PROVIDER_TOKEN,
  paymentProviderProvider,
} from './payment-provider.provider.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { StatusController } from './status.controller.js';

@Module({
  controllers: [CheckoutController, StatusController],
  providers: [CheckoutService, RateLimitGuard, paymentProviderProvider],
  exports: [CheckoutService, PAYMENT_PROVIDER_TOKEN],
})
export class CheckoutModule {}
