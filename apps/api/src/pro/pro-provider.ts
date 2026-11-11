import type { Provider } from '@nestjs/common';
import type {
  ProAutoRenewProvider,
  ProCheckoutProvider,
  ProCollectProvider,
  ProRefundProvider,
} from '@tipme/database';
import {
  bachsEnvironment,
  recordedProviderName,
  wiredPaymentProvider,
  type BachsProvider,
  type MockProvider,
} from '@tipme/payments';
import { API_CONFIG, type ApiConfig } from '../config.js';
import {
  BACHS_PROVIDER_TOKEN,
  PAYMENT_PROVIDER_TOKEN,
} from '../checkout/payment-provider.provider.js';

export const PRO_CHECKOUT_TOKEN = Symbol('PRO_CHECKOUT');

/** Where Pro is bought on this copy: exactly the configured provider, as for tips (ADR-0015). */
export interface ProCheckout {
  /** As rows record it: 'mock' or 'bachs'. */
  name: string;
  provider: ProCheckoutProvider;
  /** Real money: bachs-live. Only with PAYMENTS_LIVE_ENABLED and the page named. */
  live: boolean;
  /** The adapter's own name ('mock', 'bachs-sandbox', 'bachs-live'): which account a payment uses. */
  adapterName: string;
  /** Paying from the balance, refunds and saved cards (plan Tasks 8 to 10), on the same adapter. */
  money: ProCollectProvider & ProRefundProvider & ProAutoRenewProvider;
}

export const proCheckoutProvider: Provider<ProCheckout> = {
  provide: PRO_CHECKOUT_TOKEN,
  inject: [API_CONFIG, PAYMENT_PROVIDER_TOKEN, BACHS_PROVIDER_TOKEN],
  useFactory: (
    config: ApiConfig,
    mock: MockProvider,
    bachs: BachsProvider | null,
  ): ProCheckout => {
    const name = wiredPaymentProvider(config.PAYMENT_PROVIDER);
    if (bachsEnvironment(name)) {
      if (bachs?.name !== name)
        throw new Error(
          `PAYMENT_PROVIDER=${name} has no matching Bachs adapter`,
        );
      return {
        name: recordedProviderName(name),
        live: name === 'bachs-live',
        adapterName: name,
        money: bachs,
        provider: {
          initializePlatformCheckout: (input) =>
            bachs.initializePlatformCheckout!(input),
          verifyTransaction: (reference) => bachs.verifyTransaction(reference),
        },
      };
    }
    return {
      name: 'mock',
      live: false,
      adapterName: 'mock',
      money: mock,
      provider: {
        initializePlatformCheckout: (input) =>
          mock.initializePlatformCheckout!(input),
        verifyTransaction: (reference) => mock.verifyTransaction(reference),
      },
    };
  },
};
