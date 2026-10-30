import type { Provider } from '@nestjs/common';
import { mailSealing, type MailSealing } from '@tipme/database';
import {
  configuredMailProviders,
  type MailProvider,
  type MailProviderName,
} from '@tipme/mail';
import { API_CONFIG, type ApiConfig } from '../config.js';

/** Every configured mail provider (keys present), active or not: webhooks need them all. */
export const MAIL_PROVIDERS = Symbol('MAIL_PROVIDERS');
export const MAIL_SEALING = Symbol('MAIL_SEALING');
/** Confirms an SNS subscription by visiting its (verified) SubscribeURL. */
export const MAIL_SUBSCRIPTION_CONFIRM = Symbol('MAIL_SUBSCRIPTION_CONFIRM');

export type MailProviders = ReadonlyMap<MailProviderName, MailProvider>;
export type ConfirmSubscription = (url: string) => Promise<void>;

export const mailProvidersProvider: Provider<MailProviders> = {
  provide: MAIL_PROVIDERS,
  inject: [API_CONFIG],
  // The API never sends through the pretend provider; it only needs real providers' webhooks,
  // status and tests (tests are sent by the worker).
  useFactory: (config: ApiConfig): MailProviders =>
    configuredMailProviders(config, async () => {}),
};

export const mailSealingProvider: Provider<MailSealing> = {
  provide: MAIL_SEALING,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig) =>
    mailSealing(Buffer.from(config.MAIL_SEAL_KEY, 'base64')),
};

export const subscriptionConfirmProvider: Provider<ConfirmSubscription> = {
  provide: MAIL_SUBSCRIPTION_CONFIRM,
  useValue: async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok)
      throw new Error(`subscription confirm ${response.status}`);
  },
};
