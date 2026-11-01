import { Controller, Get, Header, Inject } from '@nestjs/common';
import type { ApiDataResponse, PaymentsHealth } from '@tipme/contracts';
import { latestReserveReading } from '@tipme/database';
import { DatabaseProvider } from '../infra/database.js';

/**
 * Whether the payment reserve is low, for the watcher (the same public footing as the other health
 * routes, so it needs no credentials). It says low or not and when it was read: never an amount,
 * a provider or an error. A reserve the worker could not read is reported low as well, since it
 * cannot be confirmed fine.
 */
@Controller()
export class PaymentsHealthController {
  constructor(
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
    const reading = await latestReserveReading(this.database.db);
    if (!reading) return { reserveLow: false, unreadable: false, readAt: null };
    return {
      reserveLow: reading.low !== false,
      unreadable: reading.low === null,
      readAt: reading.readAt.toISOString(),
    };
  }
}
