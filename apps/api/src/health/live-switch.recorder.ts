import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { recordLiveSwitch } from '@tipme/database';
import type { Logger } from '@tipme/observability';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { LOGGER } from '../tokens.js';

/**
 * Keeps the record of when live payments changed, read from what this copy was started with. A
 * failed record must not take the API down during a deploy: it is logged, and the next boot that
 * still differs records it.
 */
@Injectable()
export class LiveSwitchRecorder implements OnApplicationBootstrap {
  constructor(
    @Inject(API_CONFIG)
    private readonly config: Pick<
      ApiConfig,
      'PAYMENTS_LIVE_ENABLED' | 'PAYMENT_PROVIDER' | 'GIT_SHA'
    >,
    @Inject(DatabaseProvider)
    private readonly database: Pick<DatabaseProvider, 'db'>,
    @Inject(LOGGER) private readonly logger: Pick<Logger, 'info' | 'error'>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const live = this.config.PAYMENTS_LIVE_ENABLED;
    const version = this.config.GIT_SHA ?? 'unknown';
    try {
      const result = await recordLiveSwitch(this.database.db, {
        live,
        provider: this.config.PAYMENT_PROVIDER,
        version,
      });
      if (result === 'recorded')
        this.logger.info({ event: 'live_switch.recorded', live, version });
    } catch (error) {
      // The error's name only: a database error can carry connection details.
      this.logger.error({
        event: 'live_switch.record_failed',
        error: error instanceof Error ? error.name : typeof error,
      });
    }
  }
}
