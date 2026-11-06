import { Module } from '@nestjs/common';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { ChangelogWebhookController } from './changelog-webhook.controller.js';

@Module({
  controllers: [ChangelogWebhookController],
  providers: [RateLimitGuard],
})
export class ChangelogModule {}
