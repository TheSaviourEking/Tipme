import type { Provider } from '@nestjs/common';
import { createMockProvider, type MockProvider } from '@tipme/payments';
import type { Redis } from 'ioredis';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { REDIS } from '../infra/infra.module.js';

/** The payment provider adapter. Only the mock exists until a provider is approved (D-03). */
export const PAYMENT_PROVIDER_TOKEN = Symbol('PAYMENT_PROVIDER');

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
