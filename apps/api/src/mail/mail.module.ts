import { Module } from '@nestjs/common';
import { MailWebhookController } from './mail-webhook.controller.js';
import { UnsubscribeController } from './unsubscribe.controller.js';
import {
  mailProvidersProvider,
  mailSealingProvider,
  subscriptionConfirmProvider,
} from './mail-providers.provider.js';

@Module({
  controllers: [MailWebhookController, UnsubscribeController],
  providers: [
    mailProvidersProvider,
    mailSealingProvider,
    subscriptionConfirmProvider,
  ],
  exports: [mailProvidersProvider, mailSealingProvider],
})
export class MailModule {}
