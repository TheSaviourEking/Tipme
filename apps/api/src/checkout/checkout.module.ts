import { Module } from '@nestjs/common';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import {
  BACHS_PROVIDER_TOKEN,
  bachsProviderProvider,
  CHECKOUT_PROVIDER_TOKEN,
  checkoutProviderProvider,
  MOCK_ALT_PROVIDER_TOKEN,
  mockAltProviderProvider,
  PAYMENT_PROVIDER_TOKEN,
  paymentProviderProvider,
  PAYOUT_PROVIDERS_TOKEN,
  payoutProvidersProvider,
  WITHDRAWAL_PROVIDER_TOKEN,
  withdrawalProviderProvider,
} from './payment-provider.provider.js';
import { RateLimitGuard } from './rate-limit.guard.js';
import { ReceiptCheckService } from './receipt-check.service.js';
import { StatusController } from './status.controller.js';
import { TipLiveController } from './tip-live.controller.js';

@Module({
  controllers: [CheckoutController, StatusController, TipLiveController],
  providers: [
    CheckoutService,
    ReceiptCheckService,
    RateLimitGuard,
    paymentProviderProvider,
    bachsProviderProvider,
    checkoutProviderProvider,
    withdrawalProviderProvider,
    mockAltProviderProvider,
    payoutProvidersProvider,
  ],
  exports: [
    CheckoutService,
    PAYMENT_PROVIDER_TOKEN,
    BACHS_PROVIDER_TOKEN,
    CHECKOUT_PROVIDER_TOKEN,
    WITHDRAWAL_PROVIDER_TOKEN,
    MOCK_ALT_PROVIDER_TOKEN,
    PAYOUT_PROVIDERS_TOKEN,
  ],
})
export class CheckoutModule {}
