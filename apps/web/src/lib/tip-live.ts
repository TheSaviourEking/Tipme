import { checkoutApiUrl, checkoutCredentials } from './api-client.ts';
import { createFetchEventSource } from './fetch-event-source.ts';
import {
  createLiveClient,
  type LiveClientDeps,
  type LiveStatus,
} from './live-client.ts';

/** What followTip takes from the page; tests pass fakes. */
export type TipLiveEnv = Pick<
  LiveClientDeps,
  'now' | 'setTimeout' | 'clearTimeout' | 'random' | 'visible'
> & { fetch: typeof fetch };

const browserEnv = (): TipLiveEnv => ({
  fetch: (input, init) => fetch(input, init),
  now: () => performance.now(),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (timer) => window.clearTimeout(timer as number),
  random: Math.random,
  visible: () => document.visibilityState === 'visible',
});

/**
 * The receipt follows its tip (addendum §3.6): one stream, `GET /v1/tips/:tipId/events`, read with
 * `fetch` so the status token goes in `Authorization` and never in a URL. `onChange` asks the
 * receipt for one status read, on `tip.changed` and on each `ready` and `resync`, only while
 * connected: in every other status the receipt's own nextCheckDelay loop covers it, so the client's
 * poll ticks are ignored here. No safety refresh: a connected receipt makes no timed reads.
 */
export function followTip(
  o: {
    tipId: string;
    token: string;
    onChange: () => void;
    onStatus: (s: LiveStatus) => void;
  },
  env: TipLiveEnv = browserEnv(),
): { stop(): void } {
  const reader = createFetchEventSource({
    headers: { authorization: `Bearer ${o.token}` },
    fetch: env.fetch,
    credentials: checkoutCredentials(),
  });
  const client = createLiveClient({
    url: checkoutApiUrl(`/v1/tips/${encodeURIComponent(o.tipId)}/events`),
    EventSource: reader.EventSource,
    now: env.now,
    setTimeout: env.setTimeout,
    clearTimeout: env.clearTimeout,
    random: env.random,
    visible: env.visible,
    probe: () => reader.probe(),
    // A receipt is short-lived (15 minutes at most): it keeps its stream while hidden.
    keepOpenWhenHidden: () => true,
    timing: { safetyMs: null },
  });
  const connected = () => client.status === 'connected';
  const offs = [
    client.onStatus((s) => o.onStatus(s)),
    client.on('tip.changed', () => {
      if (connected()) o.onChange();
    }),
    client.onResync(() => {
      if (connected()) o.onChange();
    }),
  ];
  client.start();
  return {
    stop() {
      client.stop();
      for (const off of offs) off();
    },
  };
}
