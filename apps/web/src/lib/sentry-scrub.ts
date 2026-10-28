// What may leave the browser or the web server in a Sentry event (ADR-0005, D-07): no query
// strings or fragments (a receipt link carries the tip's status token), no user, cookies or
// headers, and no breadcrumbs that can carry what someone typed (console output, form input).

type Breadcrumb = {
  category?: string;
  message?: string;
  data?: Record<string, unknown>;
};

type ScrubbableEvent = {
  request?: {
    url?: string;
    query_string?: unknown;
    cookies?: unknown;
    headers?: unknown;
    data?: unknown;
  };
  user?: unknown;
  breadcrumbs?: Breadcrumb[];
};

const TYPED_TEXT = new Set(['console', 'ui.input']);

/** `/tip/1?token=x#y` → `/tip/1`; absolute URLs keep their origin and path. */
export function withoutQuery(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
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
  if (event.breadcrumbs)
    event.breadcrumbs = event.breadcrumbs
      .filter((crumb) => !TYPED_TEXT.has(crumb.category ?? ''))
      .map((crumb) =>
        crumb.data
          ? {
              ...crumb,
              data: Object.fromEntries(
                Object.entries(crumb.data).map(([key, value]) => [
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
