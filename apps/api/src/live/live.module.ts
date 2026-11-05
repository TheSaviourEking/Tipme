import { Global, Module } from '@nestjs/common';
import { liveChannel } from '@tipme/contracts';
import type { Logger } from '@tipme/observability';
import type { Redis } from 'ioredis';
import { SessionGuard } from '../auth/session.guard.js';
import { RateLimitGuard } from '../checkout/rate-limit.guard.js';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { REDIS } from '../infra/infra.module.js';
import { LOGGER } from '../tokens.js';
import { LiveController } from './live.controller.js';
import { LiveHubService } from './live-hub.service.js';
import { createLivePublisher, LIVE_PUBLISHER } from './live-publisher.js';

/**
 * The live stream and the publisher API routes call after their write resolves. Global, so any
 * controller can inject LIVE_PUBLISHER without importing this module.
 */
@Global()
@Module({
  controllers: [LiveController],
  providers: [
    LiveHubService,
    SessionGuard,
    RateLimitGuard,
    {
      provide: LIVE_PUBLISHER,
      inject: [REDIS, API_CONFIG, LOGGER, LiveHubService],
      useFactory: (
        redis: Redis,
        config: ApiConfig,
        logger: Logger,
        hub: LiveHubService,
      ) =>
        createLivePublisher({
          redis,
          channel: liveChannel(config.QUEUE_PREFIX),
          logger,
          counter: (type, outcome) => hub.metrics.published(type, outcome),
        }),
    },
  ],
  exports: [LIVE_PUBLISHER, LiveHubService],
})
export class LiveModule {}
