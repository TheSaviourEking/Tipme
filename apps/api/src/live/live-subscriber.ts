import { parseLiveMessage, type LiveMessage } from '@tipme/contracts';
import type { Logger } from '@tipme/observability';
import { Redis } from 'ioredis';

/** The part of ioredis the subscriber uses (a fake in unit tests). */
export interface SubscriberClient {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  connect(): Promise<unknown>;
  subscribe(channel: string): Promise<unknown>;
  disconnect(): void;
}

export interface LiveSubscriberOptions {
  url: string;
  channel: string;
  logger: Logger;
  onMessage(message: LiveMessage): void;
  onDown(): void;
  onUp(): void;
  onInvalid(): void;
  createClient?: (url: string) => SubscriberClient;
}

export interface LiveSubscriber {
  readonly up: boolean;
  stop(): Promise<void>;
}

function defaultClient(url: string): SubscriberClient {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    // We subscribe on every `ready` ourselves, so the hub knows exactly when it hears signals again.
    autoResubscribe: false,
    connectTimeout: 1000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt) => Math.min(attempt * 200, 2000),
  });
}

/**
 * One dedicated subscriber connection per API process (a connection in subscribe mode can't run
 * other commands). `onDown` and `onUp` fire on each transition; down and restored are logged once
 * per outage.
 */
export function startLiveSubscriber(o: LiveSubscriberOptions): LiveSubscriber {
  const client = (o.createClient ?? defaultClient)(o.url);
  let up = false;
  let stopped = false;
  let wasDown = false;

  const down = () => {
    if (!up) return;
    up = false;
    wasDown = true;
    o.logger.warn({ event: 'live.subscriber_down' });
    o.onDown();
  };

  client.on('error', () => undefined);
  client.on('close', down);
  client.on('end', down);
  client.on('ready', () => {
    if (stopped) return;
    client.subscribe(o.channel).then(
      () => {
        if (stopped || up) return;
        up = true;
        if (wasDown) {
          wasDown = false;
          o.logger.info({ event: 'live.subscriber_restored' });
        }
        o.onUp();
      },
      () => undefined,
    );
  });
  client.on('message', (channel: unknown, raw: unknown) => {
    if (channel !== o.channel || typeof raw !== 'string') return;
    const message = parseLiveMessage(raw);
    if (!message) {
      o.logger.warn({ event: 'live.message_invalid' });
      o.onInvalid();
      return;
    }
    o.onMessage(message);
  });
  client.connect().catch(() => undefined);

  return {
    get up() {
      return up;
    },
    async stop() {
      stopped = true;
      up = false;
      client.disconnect();
    },
  };
}
