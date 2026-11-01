import { deferSentry } from '@/lib/deferred-sentry';
import { sentryOptions } from '@/lib/sentry-options';

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
const sentry = dsn
  ? deferSentry(() =>
      import('@sentry/nextjs').then((client) => {
        client.init(sentryOptions(dsn));
        return client;
      }),
    )
  : undefined;

export const onRouterTransitionStart: typeof import('@sentry/nextjs').captureRouterTransitionStart =
  (...args) => sentry?.onRouterTransitionStart(...args);
