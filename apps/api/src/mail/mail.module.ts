import { Module } from '@nestjs/common';
import { MailWebhookController } from './mail-webhook.controller.js';
import { UnsubscribeController } from './unsubscribe.controller.js';
import {
  announcementProviderProvider,
  mailProvidersProvider,
  mailSealingProvider,
  subscriptionConfirmProvider,
} from './mail-providers.provider.js';

@Module({
  controllers: [MailWebhookController, UnsubscribeController],
  providers: [
    announcementProviderProvider,
    mailProvidersProvider,
    mailSealingProvider,
    subscriptionConfirmProvider,
  ],
  exports: [
    announcementProviderProvider,
    mailProvidersProvider,
    mailSealingProvider,
  ],
})
export class MailModule {}
