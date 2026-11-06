import { getMeter } from '@tipme/observability';
import { SERVICE_NAME } from '../config.js';
import type { LiveCloseReason } from './live-router.js';

export type LiveConnectOutcome =
  | 'opened'
  | 'disabled'
  | 'unauthenticated'
  | 'limit_user'
  | 'limit_process'
  | 'rate_limited'
  | 'draining'
  /** The client left during the connect, before the stream opened. */
  | 'client_gone';

export interface LiveMetrics {
  connect(outcome: LiveConnectOutcome): void;
  close(reason: LiveCloseReason): void;
  published(type: string, outcome: 'ok' | 'failed'): void;
  delivered(type: string): void;
  invalid(): void;
}

/** The API's live-update metrics (spec §10). Routine opens and closes are counted, not logged. */
export function createLiveMetrics(observe: {
  counts(): { me: number; ops: number };
  subscriberUp(): boolean;
}): LiveMetrics {
  const meter = getMeter(SERVICE_NAME);
  const streams = meter.createObservableGauge('tipme.live.streams', {
    description: 'Open live streams, by stream',
  });
  const subscriber = meter.createObservableGauge('tipme.live.subscriber', {
    description: '1 while this copy hears live signals',
  });
  meter.addBatchObservableCallback(
    (observer) => {
      const counts = observe.counts();
      observer.observe(streams, counts.me, { stream: 'me' });
      observer.observe(streams, counts.ops, { stream: 'ops' });
      observer.observe(subscriber, observe.subscriberUp() ? 1 : 0);
    },
    [streams, subscriber],
  );
  const connects = meter.createCounter('tipme.live.connects', {
    description: 'Live stream connects, by outcome',
  });
  const closes = meter.createCounter('tipme.live.closes', {
    description: 'Live stream closes, by reason',
  });
  const published = meter.createCounter('tipme.live.signals_published', {
    description: 'Live signals published, by type and outcome',
  });
  const delivered = meter.createCounter('tipme.live.signals_delivered', {
    description: 'Live signals written to a stream, by type',
  });
  const invalid = meter.createCounter('tipme.live.messages_invalid', {
    description: 'Channel messages dropped as malformed',
  });
  return {
    connect: (outcome) => connects.add(1, { outcome }),
    close: (reason) => closes.add(1, { reason }),
    published: (type, outcome) => published.add(1, { type, outcome }),
    delivered: (type) => delivered.add(1, { type }),
    invalid: () => invalid.add(1),
  };
}
