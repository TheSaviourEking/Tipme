import { Module } from '@nestjs/common';
import { MockWebhookController } from './mock-webhook.controller.js';
import { WebhookService } from './webhook.service.js';
import { BachsWebhookController } from './bachs-webhook.controller.js';
import { CheckoutModule } from '../checkout/checkout.module.js';
import { MailModule } from '../mail/mail.module.js';

@Module({
  imports: [CheckoutModule, MailModule],
  controllers: [MockWebhookController, BachsWebhookController],
  providers: [WebhookService],
})
export class WebhooksModule {}
