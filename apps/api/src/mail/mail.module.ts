import { Module } from '@nestjs/common';
import { MailWebhookController } from './mail-webhook.controller.js';
import {
  mailProvidersProvider,
  mailSealingProvider,
  subscriptionConfirmProvider,
} from './mail-providers.provider.js';

@Module({
  controllers: [MailWebhookController],
  providers: [
    mailProvidersProvider,
    mailSealingProvider,
    subscriptionConfirmProvider,
  ],
  exports: [mailProvidersProvider, mailSealingProvider],
})
export class MailModule {}
