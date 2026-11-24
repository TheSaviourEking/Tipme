import type { Provider } from '@nestjs/common';
import {
  createBachsProvider,
  createMockProvider,
  type BachsProvider,
  type MockProvider,
  type PaymentProvider,
  bachsEnvironment,
  configuredPaymentProviders,
  type WithdrawOnlyProviderName,
  wiredPaymentProvider,
} from '@tipme/payments';
import type { Redis } from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { REDIS } from '../infra/infra.module.js';

/**
 * The payment provider adapters. Bachs sandbox runs only in test or preview, Bachs live only on a
 * production copy (config enforces both); each uses only its own environment's settings.
 */
export const PAYMENT_PROVIDER_TOKEN = Symbol('PAYMENT_PROVIDER');
export const BACHS_PROVIDER_TOKEN = Symbol('BACHS_PROVIDER');
export const CHECKOUT_PROVIDER_TOKEN = Symbol('CHECKOUT_PROVIDER');
export const WITHDRAWAL_PROVIDER_TOKEN = Symbol('WITHDRAWAL_PROVIDER');
export const MOCK_ALT_PROVIDER_TOKEN = Symbol('MOCK_ALT_PROVIDER');
export const PAYOUT_PROVIDERS_TOKEN = Symbol('PAYOUT_PROVIDERS');

/** Every adapter that may hold a balance: the active one, then the withdraw-only ones in list order. */
export interface PayoutProviderSet {
  active: MockProvider | BachsProvider;
  withdrawOnly: (MockProvider | BachsProvider)[];
}

/** The configured roles; the withdraw-only list is optional in hand-built test configs. */
function rolesOf(config: ApiConfig) {
  return configuredPaymentProviders({
    PAYMENT_PROVIDER: config.PAYMENT_PROVIDER,
    PAYMENT_WITHDRAW_ONLY_PROVIDERS:
      config.PAYMENT_WITHDRAW_ONLY_PROVIDERS ?? [],
  });
}

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

/** Builds one Bachs environment from that environment's own settings, never the other's. */
function bachsFor(
  environment: 'sandbox' | 'live',
  apiKey: string | undefined,
  secret: string | undefined,
  previousSecret: string | undefined,
  platformOrganizationId: string | undefined,
): BachsProvider {
  if (!apiKey || !secret)
    throw new Error(`Bachs ${environment} configuration is incomplete`);
  return createBachsProvider({
    apiKey,
    environment,
    webhookSecrets: [secret, ...(previousSecret ? [previousSecret] : [])],
    // Paid Pro (ADR-0015): without it, TipMe's own events are read as a connected account's.
    ...(platformOrganizationId ? { platformOrganizationId } : {}),
  });
}

/** One Bachs adapter from its own environment's settings. */
function bachsForName(
  name: 'bachs-live' | 'bachs-sandbox',
  config: ApiConfig,
): BachsProvider {
  return name === 'bachs-live'
    ? bachsFor(
        'live',
        config.BACHS_LIVE_API_KEY,
        config.BACHS_LIVE_WEBHOOK_SECRET,
        config.BACHS_LIVE_PREVIOUS_WEBHOOK_SECRET,
        config.BACHS_PLATFORM_ORGANIZATION_ID,
      )
    : bachsFor(
        'sandbox',
        config.BACHS_SANDBOX_API_KEY,
        config.BACHS_WEBHOOK_SECRET,
        config.BACHS_PREVIOUS_WEBHOOK_SECRET,
        config.BACHS_PLATFORM_ORGANIZATION_ID,
      );
}

export const bachsProviderProvider: Provider<BachsProvider | null> = {
  provide: BACHS_PROVIDER_TOKEN,
  inject: [API_CONFIG],
  useFactory: (config: ApiConfig): BachsProvider | null => {
    // Fails startup for a provider this build cannot run (never a silent mock).
    const name = wiredPaymentProvider(config.PAYMENT_PROVIDER);
    // A Bachs that is only withdraw-only still needs its adapter, and its webhooks accepted. Config
    // keeps sandbox and live apart by environment, so at most one Bachs exists per copy.
    const withdrawOnlyBachs = rolesOf(config).withdrawOnly.find(
      (n) => n === 'bachs-live' || n === 'bachs-sandbox',
    );
    if (!bachsEnvironment(name) && withdrawOnlyBachs)
      return bachsForName(withdrawOnlyBachs, config);
    switch (name) {
      case 'bachs-live':
      case 'bachs-sandbox':
        return bachsForName(name, config);
      case 'mock':
        // A test or preview copy back on mock still answers Bachs sandbox callbacks and status
        // checks for tips it took earlier. Config keeps live settings off non-production copies.
        if (!config.BACHS_SANDBOX_API_KEY && !config.BACHS_WEBHOOK_SECRET)
          return null;
        return bachsForName('bachs-sandbox', config);
      default: {
        const unreachable: never = name;
        throw new Error(`PAYMENT_PROVIDER=${String(unreachable)} is not wired`);
      }
    }
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
    const name = wiredPaymentProvider(config.PAYMENT_PROVIDER);
    if (bachsEnvironment(name)) {
      // Checkout goes through exactly the configured Bachs: never mock, never the other one.
      if (bachs?.name !== name)
        throw new Error(
          `PAYMENT_PROVIDER=${name} has no matching Bachs adapter`,
        );
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

/** Withdrawals go through exactly the configured provider, as checkout does. */
export const withdrawalProviderProvider: Provider<
  MockProvider | BachsProvider
> = {
  provide: WITHDRAWAL_PROVIDER_TOKEN,
  inject: [API_CONFIG, PAYMENT_PROVIDER_TOKEN, BACHS_PROVIDER_TOKEN],
  useFactory: (
    config: ApiConfig,
    mock: MockProvider,
    bachs: BachsProvider | null,
  ): MockProvider | BachsProvider => {
    const name = wiredPaymentProvider(config.PAYMENT_PROVIDER);
    if (!bachsEnvironment(name)) return mock;
    if (bachs?.name !== name)
      throw new Error(`PAYMENT_PROVIDER=${name} has no matching Bachs adapter`);
    return bachs;
  },
};

/** The second pretend provider, built only when listed (test copies). */
export const mockAltProviderProvider: Provider<MockProvider | null> = {
  provide: MOCK_ALT_PROVIDER_TOKEN,
  inject: [API_CONFIG, REDIS],
  useFactory: (config: ApiConfig, redis: Redis): MockProvider | null =>
    rolesOf(config).withdrawOnly.includes('mock_alt')
      ? createMockProvider({
          redis,
          secret: config.MOCK_PROVIDER_WEBHOOK_SECRET ?? '',
          prefix: config.QUEUE_PREFIX,
          name: 'mock_alt',
        })
      : null,
};

/** One adapter per provider in either role; checkout still uses only the active one. */
export const payoutProvidersProvider: Provider<PayoutProviderSet> = {
  provide: PAYOUT_PROVIDERS_TOKEN,
  inject: [
    API_CONFIG,
    PAYMENT_PROVIDER_TOKEN,
    BACHS_PROVIDER_TOKEN,
    MOCK_ALT_PROVIDER_TOKEN,
  ],
  useFactory: (
    config: ApiConfig,
    mock: MockProvider,
    bachs: BachsProvider | null,
    mockAlt: MockProvider | null,
  ): PayoutProviderSet => {
    const { active, withdrawOnly } = rolesOf(config);
    const adapterFor = (
      name: WithdrawOnlyProviderName | typeof active,
    ): MockProvider | BachsProvider => {
      if (name === 'mock') return mock;
      if (name === 'mock_alt') {
        if (!mockAlt) throw new Error('mock_alt is listed but has no adapter');
        return mockAlt;
      }
      if (bachs?.name !== name)
        throw new Error(`${name} is configured but has no matching adapter`);
      return bachs;
    };
    return {
      active: adapterFor(active),
      withdrawOnly: withdrawOnly.map(adapterFor),
    };
  },
};
