import type { Provider } from '@nestjs/common';
import {
  createBachsProvider,
  createMockProvider,
  type BachsProvider,
  type MockProvider,
  type PaymentProvider,
} from '@tipme/payments';
import type { Redis } from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { REDIS } from '../infra/infra.module.js';

/** The payment provider adapter. Bachs is sandbox-only and selectable only in test or preview. */
export const PAYMENT_PROVIDER_TOKEN = Symbol('PAYMENT_PROVIDER');
export const BACHS_PROVIDER_TOKEN = Symbol('BACHS_PROVIDER');
export const CHECKOUT_PROVIDER_TOKEN = Symbol('CHECKOUT_PROVIDER');

export type CheckoutPaymentProvider = Pick<
  PaymentProvider,
  'name' | 'initializePayment'
> & {
  getCheckoutUrl?: (providerReference: string) => Promise<string>;
};

export const paymentProviderProvider: Provider<MockProvider> = {
  provide: PAYMENT_PROVIDER_TOKEN,
  inject: [API_CONFIG, REDIS],
  useFactory: (config: ApiConfig, redis: Redis) =>
    createMockProvider({
      redis,
      secret: config.MOCK_PROVIDER_WEBHOOK_SECRET ?? '',
      prefix: config.QUEUE_PREFIX,
    }),
};

export const bachsProviderProvider: Provider<BachsProvider | null> = {
  provide: BACHS_PROVIDER_TOKEN,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig): BachsProvider | null => {
    if (!config.BACHS_SANDBOX_API_KEY && !config.BACHS_WEBHOOK_SECRET)
      return null;
    if (!config.BACHS_SANDBOX_API_KEY || !config.BACHS_WEBHOOK_SECRET)
      throw new Error('Bachs sandbox configuration is incomplete');
    return createBachsProvider({
      apiKey: config.BACHS_SANDBOX_API_KEY,
      webhookSecrets: [
        config.BACHS_WEBHOOK_SECRET,
        ...(config.BACHS_PREVIOUS_WEBHOOK_SECRET
          ? [config.BACHS_PREVIOUS_WEBHOOK_SECRET]
          : []),
      ],
    });
  },
};

export const checkoutProviderProvider: Provider<CheckoutPaymentProvider> = {
  provide: CHECKOUT_PROVIDER_TOKEN,
  inject: [API_CONFIG, PAYMENT_PROVIDER_TOKEN, BACHS_PROVIDER_TOKEN],
  useFactory: (
    config: ApiConfig,
    mock: MockProvider,
    bachs: BachsProvider | null,
  ): CheckoutPaymentProvider => {
    if (config.PAYMENT_PROVIDER === 'bachs-sandbox') {
      if (!bachs) throw new Error('Bachs sandbox provider is unavailable');
      return {
        name: bachs.name,
        initializePayment: (input) => bachs.initializePayment(input),
        getCheckoutUrl: (reference) => bachs.getCheckoutUrl(reference),
      };
    }
    return {
      name: mock.name,
      initializePayment: ({ attemptId, amountMinor, currency }) =>
        mock.initializePayment({ attemptId, amountMinor, currency }),
    };
  },
};
