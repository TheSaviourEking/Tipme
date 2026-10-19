import { Module } from '@nestjs/common';
import { CheckoutModule } from './checkout.module.js';
import { MockCheckoutController } from './mock-checkout.controller.js';

/** Imported only when PAYMENT_PROVIDER is the mock (which is itself refused in production). */
@Module({
  imports: [CheckoutModule],
  controllers: [MockCheckoutController],
})
export class MockCheckoutModule {}
