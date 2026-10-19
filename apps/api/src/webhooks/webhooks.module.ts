import { Module } from '@nestjs/common';
import { MockWebhookController } from './mock-webhook.controller.js';
import { WebhookService } from './webhook.service.js';

@Module({
  controllers: [MockWebhookController],
  providers: [WebhookService],
})
export class WebhooksModule {}
