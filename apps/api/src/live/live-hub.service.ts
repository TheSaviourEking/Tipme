import {
  Inject,
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { liveChannel, type LiveMessage } from '@tipme/contracts';
import type { Logger } from '@tipme/observability';
import { API_CONFIG, type ApiConfig } from '../config.js';
import { ReadinessService } from '../health/readiness.service.js';
import { LOGGER } from '../tokens.js';
import { createLiveMetrics, type LiveMetrics } from './live-metrics.js';
import {
  createLiveRouter,
  type LiveRouter,
  type LiveSink,
  type RegisterResult,
} from './live-router.js';
import {
  startLiveSubscriber,
  type LiveSubscriber,
  type SubscriberClient,
} from './live-subscriber.js';

const MAX_STREAMS_PER_USER = 8;
const COALESCE_MS = 250;

export interface LiveHub {
  start(): void;
  stop(): Promise<void>;
  register(sink: LiveSink): RegisterResult;
  unregister(id: string): void;
  dispatch(message: LiveMessage): void;
  drain(): void;
  readonly draining: boolean;
  readonly subscriberUp: boolean;
  readonly invalidCount: number;
  counts(): { me: number; ops: number };
}

/** The router plus this process's one subscriber. Framework-free, so it is unit-tested directly. */
export function createLiveHub(o: {
  url: string;
  channel: string;
  logger: Logger;
  maxStreams: number;
  metrics?: Pick<LiveMetrics, 'delivered' | 'invalid'>;
  createClient?: (url: string) => SubscriberClient;
}): LiveHub {
  const router: LiveRouter = createLiveRouter({
    maxPerUser: MAX_STREAMS_PER_USER,
    maxStreams: o.maxStreams,
    coalesceMs: COALESCE_MS,
    random: Math.random,
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref();
      return timer;
    },
    clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
    onDelivered: (type) => o.metrics?.delivered(type),
  });
  let subscriber: LiveSubscriber | null = null;
  let invalid = 0;
  return {
    start() {
      if (subscriber) return;
      subscriber = startLiveSubscriber({
        url: o.url,
        channel: o.channel,
        logger: o.logger,
        createClient: o.createClient,
        onMessage: (message) => router.dispatch(message),
        // This copy can't hear signals: its pages poll until it can again.
        onDown: () => router.broadcastControl('poll'),
        onUp: () => router.broadcastControl('resync'),
        onInvalid: () => {
          invalid += 1;
          o.metrics?.invalid();
        },
      });
    },
    async stop() {
      await subscriber?.stop();
      subscriber = null;
    },
    register: (sink) => router.register(sink),
    unregister: (id) => router.unregister(id),
    dispatch: (message) => router.dispatch(message),
    drain: () => router.drain(),
    get draining() {
      return router.draining;
    },
    get subscriberUp() {
      return subscriber?.up ?? false;
    },
    get invalidCount() {
      return invalid;
    },
    counts: () => router.counts(),
  };
}

/** Nest wrapper: one hub per API process, started with the module and drained with the copy. */
@Injectable()
export class LiveHubService implements OnModuleInit, OnApplicationShutdown {
  readonly metrics: LiveMetrics;
  private readonly hub: LiveHub;

  constructor(
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOGGER) logger: Logger,
    @Inject(ReadinessService) readiness: ReadinessService,
  ) {
    let hub: LiveHub | null = null;
    this.metrics = createLiveMetrics({
      counts: () => hub?.counts() ?? { me: 0, ops: 0 },
      subscriberUp: () => hub?.subscriberUp ?? false,
    });
    hub = createLiveHub({
      url: config.REDIS_URL,
      channel: liveChannel(config.QUEUE_PREFIX),
      logger,
      maxStreams: config.LIVE_MAX_STREAMS,
      metrics: this.metrics,
    });
    this.hub = hub;
    // Without this, closeIdleConnections never closes a stream and every stop waits out its deadline.
    readiness.onDrain(() => hub.drain());
  }

  onModuleInit(): void {
    // Turned off, nothing listens: the routes answer 204 and no subscriber connection is spent.
    if (this.config.LIVE_UPDATES_ENABLED) this.hub.start();
  }

  async onApplicationShutdown(): Promise<void> {
    this.hub.drain();
    await this.hub.stop();
  }

  register(sink: LiveSink): RegisterResult {
    return this.hub.register(sink);
  }

  unregister(id: string): void {
    this.hub.unregister(id);
  }

  drain(): void {
    this.hub.drain();
  }

  get draining(): boolean {
    return this.hub.draining;
  }

  get subscriberUp(): boolean {
    return this.hub.subscriberUp;
  }

  counts(): { me: number; ops: number } {
    return this.hub.counts();
  }
}
