import {
  Global,
  Inject,
  Injectable,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { switchesChanged, type FeatureSwitch } from '@tipme/contracts';
import {
  featureOn,
  invalidateFeatureSwitches,
  onFeatureSwitchReadError,
  seedFeatureSwitches,
} from '@tipme/database';
import type { Logger } from '@tipme/observability';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { DatabaseProvider } from '../infra/database.js';
import { LIVE_PUBLISHER, type PublishLive } from '../live/live-publisher.js';
import { LOGGER } from '../tokens.js';

/**
 * Feature switches in the API (owner, 14 Nov 2026; docs/runbooks/settings-and-switches.md). At start
 * it writes any switch without a row from the old variable, so nothing changes on release day, and
 * names any old variable now ignored. `on` is `featureOn` over this copy's database handle.
 */
@Injectable()
export class FeatureSwitches implements OnModuleInit, OnApplicationShutdown {
  private stopListening: (() => void) | null = null;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(DatabaseProvider) private readonly database: DatabaseProvider,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(LIVE_PUBLISHER) private readonly publishLive: PublishLive,
  ) {}

  async onModuleInit(): Promise<void> {
    this.stopListening = onFeatureSwitchReadError((error) =>
      // The error's name only, as for other reads that fall back.
      this.logger.warn({
        event: 'feature_switch.read_failed',
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
    // A copy starts even while the database is away (readiness says so). Without its rows, each
    // switch reads this copy's old variable, else the default: as before; the next start writes them.
    let seeded: Awaited<ReturnType<typeof seedFeatureSwitches>>;
    try {
      seeded = await seedFeatureSwitches(
        this.database.db,
        this.config.switchSeeds,
      );
    } catch (error) {
      this.logger.warn({
        event: 'feature_switch.seed_failed',
        error: error instanceof Error ? error.name : 'unknown',
      });
      return;
    }
    const { written, ignored } = seeded;
    for (const { key, source } of written)
      this.logger.info({ event: 'feature_switch.seeded', key, source });
    // Deprecated: the stored value wins. Named, never shown: delete the line from the env file.
    for (const name of ignored)
      this.logger.warn({ event: 'feature_switch.env_ignored', setting: name });
  }

  onApplicationShutdown(): void {
    this.stopListening?.();
  }

  on(key: FeatureSwitch): Promise<boolean> {
    return featureOn(this.database.db, key);
  }

  /** After a change commits: this copy forgets at once, the others on the live channel. */
  changed(): void {
    invalidateFeatureSwitches();
    void this.publishLive(switchesChanged);
  }
}

@Global()
@Module({ providers: [FeatureSwitches], exports: [FeatureSwitches] })
export class FeatureSwitchesModule {}
