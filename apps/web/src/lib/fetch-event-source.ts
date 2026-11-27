import type {
  EventSourceLike,
  LiveClientDeps,
  LiveProbe,
} from './live-client.ts';

/**
 * An EventSource that reads `text/event-stream` with `fetch`, for the receipt's stream (addendum
 * §3.6): EventSource can't send headers, and the receipt's status token must travel in
 * `Authorization`, never in a URL (where access logs would keep it). Framework-free and unit-tested
 * (apps/web/test/fetch-event-source.test.mjs).
 *
 * It behaves as the live client expects of EventSource: `onopen` on a 200 event stream,
 * `onmessage` for each `data:` event, named events (`hb`) to `addEventListener`, and `onerror`
 * with `readyState` 2 on any other answer, a failure or the stream's end. It never reconnects by
 * itself; the live client decides. `probe()` answers from the status it last saw, with no second
 * request.
 */

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

export function createFetchEventSource(o: {
  headers: Record<string, string>;
  fetch: typeof fetch;
  /** 'omit' by default; the preview gate needs its cookie on staging (checkoutCredentials). */
  credentials?: RequestCredentials;
}): {
  EventSource: LiveClientDeps['EventSource'];
  probe(): Promise<LiveProbe>;
} {
  /** The last answer's status; null before one, or when the request itself failed. */
  let lastStatus: number | null = null;

  class FetchEventSource implements EventSourceLike {
    readyState = CONNECTING;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    private readonly listeners = new Map<string, Set<() => void>>();
    private readonly abort = new AbortController();
    private closed = false;

    // The live client's `withCredentials` is EventSource's; credentials here are `o.credentials`.
    constructor(url: string) {
      void this.run(url);
    }

    addEventListener(type: string, listener: () => void): void {
      let set = this.listeners.get(type);
      if (!set) this.listeners.set(type, (set = new Set()));
      set.add(listener);
    }

    close(): void {
      this.closed = true;
      this.readyState = CLOSED;
      this.abort.abort();
    }

    private fail(): void {
      if (this.closed) return;
      this.closed = true;
      this.readyState = CLOSED;
      this.abort.abort();
      this.onerror?.({});
    }

    private async run(url: string): Promise<void> {
      let response: Response;
      try {
        response = await o.fetch(url, {
          headers: { accept: 'text/event-stream', ...o.headers },
          credentials: o.credentials ?? 'omit',
          cache: 'no-store',
          signal: this.abort.signal,
        });
      } catch {
        lastStatus = null;
        this.fail();
        return;
      }
      lastStatus = response.status;
      const type = response.headers.get('content-type') ?? '';
      if (
        response.status !== 200 ||
        !type.startsWith('text/event-stream') ||
        !response.body
      ) {
        void response.body?.cancel().catch(() => undefined);
        this.fail();
        return;
      }
      if (this.closed) {
        void response.body.cancel().catch(() => undefined);
        return;
      }
      this.readyState = OPEN;
      this.onopen?.({});
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const parse = frameParser((event, data) => this.dispatch(event, data));
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done || this.closed) break;
          parse(decoder.decode(value, { stream: true }));
        }
      } catch {
        // Aborted by close(), or the connection broke: the latter is reported below.
      }
      // The server ended the stream, or it broke: the live client decides what next.
      this.fail();
    }

    private dispatch(event: string, data: string): void {
      if (this.closed) return;
      if (event === 'message') {
        this.onmessage?.({ data });
        return;
      }
      for (const listener of [...(this.listeners.get(event) ?? [])]) listener();
    }
  }

  return {
    EventSource: FetchEventSource,
    probe() {
      const status = lastStatus;
      if (status === 204 || status === 404) return Promise.resolve('disabled');
      if (status === 429 || status === 503) return Promise.resolve('refused');
      return Promise.resolve('error');
    },
  };
}

/**
 * The event-stream format's line rules, for what this stream sends: `data:` and `event:` fields,
 * comments, and a blank line ending each event. Lines may end in \n, \r\n or \r, and a chunk may
 * end anywhere, even between a \r and its \n.
 */
function frameParser(
  dispatch: (event: string, data: string) => void,
): (chunk: string) => void {
  let buffer = '';
  let event = '';
  let data: string[] = [];
  const line = (text: string) => {
    if (text === '') {
      if (data.length > 0) dispatch(event || 'message', data.join('\n'));
      event = '';
      data = [];
      return;
    }
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    // `retry` and `id` are the live client's business, and it never needs them from here.
  };
  return (chunk) => {
    buffer += chunk;
    // A trailing \r may be the first half of \r\n: keep it for the next chunk.
    const held = buffer.endsWith('\r') ? '\r' : '';
    const text = held ? buffer.slice(0, -1) : buffer;
    const lines = text.split(/\r\n|\r|\n/);
    buffer = (lines.pop() ?? '') + held;
    for (const one of lines) line(one);
  };
}
