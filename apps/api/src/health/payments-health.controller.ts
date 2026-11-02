import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { ApiDataResponse, PaymentsHealth } from '@tipme/contracts';
import {
  currentLiveSwitch,
  latestReserveReading,
  reserveIsStale,
} from '@tipme/database';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';

/**
 * Whether the payment reserve is low, for the watcher (the same public footing as the other health
 * routes, so it needs no credentials). It says low, unreadable or stale and when it was read:
 * never an amount, a provider or an error. The worker alerts on low and unreadable; `stale` is
 * what the watcher alarms on, since a stopped worker cannot alert for itself.
 */
@Controller()
export class PaymentsHealthController {
  constructor(
    @Inject(API_CONFIG)
    private readonly config: Pick<
      ApiConfig,
      'PAYMENT_PROVIDER' | 'PAYMENTS_LIVE_ENABLED'
    >,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
  ) {}

  // Public, so a flood of requests shares one lookup at a time instead of one query each.
  private pending: Promise<PaymentsHealth> | null = null;

  @Get('health/payments')
  @Header('Cache-Control', 'no-store')
  async payments(): Promise<ApiDataResponse<PaymentsHealth>> {
    this.pending ??= this.read().finally(() => {
      this.pending = null;
    });
    return { data: await this.pending };
  }

  private async read(): Promise<PaymentsHealth> {
    const [reading, recorded] = await Promise.all([
      latestReserveReading(this.database.db),
      currentLiveSwitch(this.database.db),
    ]);
    // Checks are expected only when the worker runs the live provider with payments on. A copy
    // with payments off, on the sandbox or on the mock has nothing to be late about.
    const expected =
      this.config.PAYMENT_PROVIDER === 'bachs-live' &&
      this.config.PAYMENTS_LIVE_ENABLED;
    return {
      reserveLow: reading?.low === true,
      unreadable: reading?.low === null,
      stale:
        expected && (!reading || reserveIsStale(reading.readAt, new Date())),
      readAt: reading ? reading.readAt.toISOString() : null,
      switchRecordMatches:
        (recorded?.live ?? false) === this.config.PAYMENTS_LIVE_ENABLED,
    };
  }
}
