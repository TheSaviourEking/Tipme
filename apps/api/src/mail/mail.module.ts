import { Module } from '@nestjs/common';
import { MailWebhookController } from './mail-webhook.controller.js';
import { UnsubscribeController } from './unsubscribe.controller.js';
import {
  announcementProviderProvider,
  mailHealthProvider,
  mailProvidersProvider,
  mailSealingProvider,
  subscriptionConfirmProvider,
} from './mail-providers.provider.js';

@Module({
  controllers: [MailWebhookController, UnsubscribeController],
  providers: [
    announcementProviderProvider,
    mailHealthProvider,
    mailProvidersProvider,
    mailSealingProvider,
    subscriptionConfirmProvider,
  ],
  exports: [
    announcementProviderProvider,
    mailHealthProvider,
    mailProvidersProvider,
    mailSealingProvider,
  ],
})
export class MailModule {}
