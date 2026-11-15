// What may leave the browser or the web server in a Sentry event (ADR-0005, D-07): no query
// strings or fragments (a receipt link carries the tip's status token), no user, cookies or
// headers, and no breadcrumbs that can carry what someone typed (console output, form input).

type Breadcrumb = {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
};

type ScrubbableEvent = {
  type?: string;
  spans?: { description?: string; data?: Record<string, unknown> }[];
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    headers?: unknown;
    data?: unknown;
  };
  user?: unknown;
  breadcrumbs?: Breadcrumb[];
  extra?: unknown;
  contexts?: unknown;
};

/** Keys never sent anywhere, at any depth: a supporter's recognition key (repeat supporters). */
const NEVER_SENT = new Set(['supporterKey']);

function withoutSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || typeof value !== 'object' || value === null) return value;
  if (Array.isArray(value))
    return value.map((item) => withoutSecrets(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !NEVER_SENT.has(key))
      .map(([key, item]) => [key, withoutSecrets(item, depth + 1)]),
  );
}

const TYPED_TEXT = new Set(['console', 'ui.input']);

/** `/tip/1?token=x#y` → `/tip/1`; absolute URLs keep their origin and path. */
export function withoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

/** Span attributes that only ever hold a query string or fragment: dropped whole. */
const QUERY_KEYS = new Set([
  'url.query',
  'http.query',
  'url.fragment',
  'http.fragment',
  'query_string',
]);

const EMAIL = /[^\s@/<>"']+@[^\s@/<>"']+\.[^\s@/<>"']+/g;
const PHONE = /\+?\d[\d\s().-]{7,}\d/g;

/**
 * Free text from a span (a description, an attribute): URL-like words lose their query and
 * fragment, then emails and phone numbers are replaced.
 */
export function scrubText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((word) => (/^(https?:\/\/|\/)/.test(word) ? withoutQuery(word) : word))
    .join('')
    .replace(EMAIL, '[email]')
    .replace(PHONE, '[phone]');
}

type SpanLike = {
  description?: string;
  data?: Record<string, unknown>;
};

/** Same rules as the rest of the event, for one span (also a standalone span or the root span). */
export function scrubSpan<T extends SpanLike>(span: T): T {
  const out: T = { ...span };
  if (typeof out.description === 'string')
    out.description = scrubText(out.description);
  if (out.data)
    out.data = Object.fromEntries(
      Object.entries(out.data)
        .filter(([key]) => !NEVER_SENT.has(key) && !QUERY_KEYS.has(key))
        .map(([key, value]) => [
          key,
          typeof value === 'string'
            ? scrubText(value)
            : Array.isArray(value)
              ? value.map((item) =>
                  typeof item === 'string' ? scrubText(item) : item,
                )
              : value,
        ]),
    );
  return out;
}

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  if (event.request) {
    const { url, ...rest } = event.request;
    delete rest.query_string;
    delete rest.cookies;
    delete rest.headers;
    delete rest.data;
    event.request = { ...rest, ...(url ? { url: withoutQuery(url) } : {}) };
  }
  // Nothing about the person. Sentry still infers an IP from the request itself; the
  // organization setting "Prevent Storing of IP Addresses" must be on (docs/runbooks/sentry.md).
  if ('user' in event) delete event.user;
  if (event.extra !== undefined) event.extra = withoutSecrets(event.extra);
  if (event.contexts !== undefined)
    event.contexts = withoutSecrets(event.contexts);
  if (event.type === 'transaction') {
    // The root span sits in contexts.trace; the rest in spans.
    const contexts = event.contexts as { trace?: SpanLike } | undefined;
    if (contexts?.trace)
      event.contexts = { ...contexts, trace: scrubSpan(contexts.trace) };
    if (event.spans) event.spans = event.spans.map(scrubSpan);
  }
  if (event.breadcrumbs)
    event.breadcrumbs = event.breadcrumbs
      .filter((crumb) => !TYPED_TEXT.has(crumb.category ?? ''))
      .map((crumb) =>
        crumb.data
          ? {
              ...crumb,
              data: Object.fromEntries(
                Object.entries(crumb.data)
                  .filter(([key]) => !NEVER_SENT.has(key))
                  .map(([key, value]) => [
                    key,
                    typeof value === 'string' &&
                    ['url', 'from', 'to'].includes(key)
                      ? withoutQuery(value)
                      : value,
                  ]),
              ),
            }
          : crumb,
      );
  return event;
}
