import { randomBytes } from 'node:crypto';

// Error reporting (PR-011): unexpected server errors sent in Sentry's envelope format to Sentry or
// any compatible service (e.g. GlitchTip), by TipMe itself rather than an SDK, so exactly what
// leaves the server is decided here: the error type, a safe code, stack frames, the service, the
// route or job and the trace id. Never the message (it can quote request data), the request,
// cookies, headers or user. Off unless a DSN is configured.

export interface ErrorContext {
  /** The route pattern (e.g. `/v1/me/profile`), never the concrete URL. */
  route?: string;
  /** A worker job name. */
  job?: string;
  traceId?: string;
}

export interface ErrorReporter {
  capture(error: unknown, context?: ErrorContext): void;
  /** Waits for reports in flight (tests and shutdown). */
  flush(): Promise<void>;
}

interface Frame {
  function?: string;
  filename: string;
  lineno: number;
  colno?: number;
  in_app: boolean;
}

const PER_MINUTE = 30;

/** `https://<key>@<host>/<project>` → the envelope endpoint and its key. */
function parseDsn(dsn: string): { url: string; key: string } {
  const parsed = new URL(dsn);
  const project = parsed.pathname.replace(/^\/+|\/+$/g, '');
  if (
    !/^https?:$/.test(parsed.protocol) ||
    !parsed.username ||
    !/^[\w-]+$/.test(project)
  )
    throw new Error('SENTRY_DSN must look like https://<key>@<host>/<project>');
  return {
    url: `${parsed.protocol}//${parsed.host}/api/${project}/envelope/`,
    key: decodeURIComponent(parsed.username),
  };
}

/** Where a frame's file is, without anything about the machine: TipMe's own code from `apps/` or
 *  `packages/`, a dependency from `node_modules/`, Node's internals, or else only the file name. */
function safeFilename(raw: string): string {
  const path = raw.replace(/^file:\/\//, '');
  if (path.startsWith('node:')) return path;
  const own = /(?:^|\/)((?:apps|packages)\/.*)$/.exec(path);
  if (own?.[1] && !own[1].includes('/node_modules/')) return own[1];
  const dependency = /(?:^|\/)(node_modules\/.*)$/.exec(path);
  if (dependency?.[1]) return dependency[1];
  return path.split('/').pop() ?? '';
}

/**
 * Stack frames, oldest first as Sentry expects. Only lines after the message are read (a message
 * can itself contain lines that look like frames), and paths go through `safeFilename`.
 */
function framesOf(error: Error): Frame[] {
  const messageLines = error.message.split('\n').length;
  const frames: Frame[] = [];
  for (const line of (error.stack ?? '').split('\n').slice(messageLines)) {
    const match = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    const filename = safeFilename(match[2] ?? '');
    frames.push({
      ...(match[1] ? { function: match[1] } : {}),
      filename,
      lineno: Number(match[3]),
      colno: Number(match[4]),
      in_app:
        !filename.startsWith('node_modules') && !filename.startsWith('node:'),
    });
  }
  return frames.reverse();
}

/** Only values that cannot carry personal data: database states and TipMe's own error codes. */
function safeValue(error: unknown): string {
  const record = (error ?? {}) as { sqlState?: unknown; code?: unknown };
  if (
    typeof record.sqlState === 'string' &&
    /^[0-9A-Z]{5}$/.test(record.sqlState)
  )
    return `SQLSTATE ${record.sqlState}`;
  if (
    typeof record.code === 'string' &&
    /^[A-Z][A-Z_]{2,40}$/.test(record.code)
  )
    return record.code;
  return '(message withheld)';
}

export function createErrorReporter(options: {
  dsn: string | undefined;
  service: string;
  environment?: string;
  release?: string;
  fetchImpl?: typeof fetch;
}): ErrorReporter {
  if (!options.dsn)
    return { capture: () => undefined, flush: async () => undefined };
  const target = parseDsn(options.dsn);
  const send = options.fetchImpl ?? fetch;
  const inFlight = new Set<Promise<unknown>>();
  let windowStart = Date.now();
  let sent = 0;

  return {
    capture(error, context = {}) {
      if (Date.now() - windowStart >= 60_000) {
        windowStart = Date.now();
        sent = 0;
      }
      if (++sent > PER_MINUTE) return;
      const eventId = randomBytes(16).toString('hex');
      const tags: Record<string, string> = { service: options.service };
      if (context.route) tags['route'] = context.route;
      if (context.job) tags['job'] = context.job;
      const event = {
        event_id: eventId,
        timestamp: Date.now() / 1000,
        platform: 'node',
        level: 'error',
        environment: options.environment ?? 'unknown',
        ...(options.release ? { release: options.release } : {}),
        tags,
        ...(context.traceId
          ? { contexts: { trace: { trace_id: context.traceId } } }
          : {}),
        exception: {
          values: [
            {
              type: error instanceof Error ? error.name : typeof error,
              value: safeValue(error),
              stacktrace: {
                frames: error instanceof Error ? framesOf(error) : [],
              },
            },
          ],
        },
      };
      const body = [
        JSON.stringify({
          event_id: eventId,
          sent_at: new Date().toISOString(),
        }),
        JSON.stringify({ type: 'event' }),
        JSON.stringify(event),
      ].join('\n');
      const request = send(target.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_client=tipme/1.0, sentry_key=${target.key}`,
        },
        body: `${body}\n`,
        signal: AbortSignal.timeout(3000),
      })
        // Reporting must never break the request or job that failed.
        .catch(() => undefined)
        .finally(() => inFlight.delete(request));
      inFlight.add(request);
    },
    async flush() {
      await Promise.all([...inFlight]);
    },
  };
}
