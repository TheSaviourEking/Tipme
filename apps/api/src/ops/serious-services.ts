import type { Provider } from '@nestjs/common';
import {
  registerRealSeriousActions,
  type MailSealing,
  type SeriousActionOutcome,
  type SeriousActionServices,
  type StaffPayoutReader,
} from '@tipme/database';
import type { OpsActedAlone, OpsSeriousPending } from '@tipme/contracts';
import type { MailProviderName } from '@tipme/mail';
import type { Logger } from '@tipme/observability';
import type { BachsProvider, MockProvider } from '@tipme/payments';
import type { Response } from 'express';
import {
  BACHS_PROVIDER_TOKEN,
  PAYMENT_PROVIDER_TOKEN,
} from '../checkout/payment-provider.provider.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { CodedHttpException } from '../http/coded.exception.js';
import {
  MAIL_PROVIDERS,
  MAIL_SEALING,
  type MailProviders,
} from '../mail/mail-providers.provider.js';
import { LOGGER } from '../tokens.js';

export const SERIOUS_SERVICES = Symbol('SERIOUS_SERVICES');

const STATUS_TIMEOUT_MS = 3000;

/** What the real serious actions need from the app, for asking and approving alike. */
export const seriousServicesProvider: Provider<SeriousActionServices> = {
  provide: SERIOUS_SERVICES,
  inject: [
    API_CONFIG,
    MAIL_SEALING,
    MAIL_PROVIDERS,
    PAYMENT_PROVIDER_TOKEN,
    BACHS_PROVIDER_TOKEN,
    LOGGER,
  ],
  useFactory: (
    config: ApiConfig,
    sealing: MailSealing,
    providers: MailProviders,
    mock: MockProvider,
    bachs: BachsProvider | null,
    logger: Logger,
  ): SeriousActionServices => {
    registerRealSeriousActions();
    return {
      sealing,
      authCodeSecret: config.AUTH_CODE_SECRET,
      payoutReader: (name): StaffPayoutReader => {
        if (name === 'mock') return mock;
        if (name === 'bachs' && bachs) return bachs;
        throw new CodedHttpException(503, 'DEPENDENCY_UNAVAILABLE');
      },
      payoutLog: (entry) => logger.warn({ ...entry }),
      businessSharesEnabled:
        config.BUSINESS_ENABLED && config.BUSINESS_SHARES_ENABLED,
      mail: {
        production:
          config.NODE_ENV === 'production' &&
          config.DEPLOYMENT_MODE !== 'preview',
        configured: new Set(providers.keys()),
        fallback: config.MAIL_DEFAULT_PROVIDER,
        status: async (name) => {
          const provider = providers.get(name as MailProviderName);
          if (!provider) return null;
          let timer: NodeJS.Timeout | undefined;
          const status = await Promise.race([
            provider.status().catch(() => null),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), STATUS_TIMEOUT_MS);
            }),
          ]);
          clearTimeout(timer);
          return status;
        },
      },
    };
  },
};

/**
 * A pending action answers 202 { requestId }; one that ran goes on to the route's normal answer,
 * which says so if it ran without a second person: the screen must not leave that to the log.
 */
export function pendingOr<Result>(
  outcome: SeriousActionOutcome | { state: 'applied'; result: Result },
  response: Response,
): { pending: OpsSeriousPending } | { result: Result & OpsActedAlone } {
  if (outcome.state === 'pending') {
    response.status(202);
    return {
      pending: {
        requestId: outcome.requestId,
        ...(outcome.repeat ? { repeat: true as const } : {}),
      },
    };
  }
  if (outcome.state === 'ran')
    return {
      result: { ...(outcome.result as Result), actedAlone: true as const },
    };
  return { result: outcome.result as Result & OpsActedAlone };
}
