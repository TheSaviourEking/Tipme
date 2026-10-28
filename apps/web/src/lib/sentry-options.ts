import { scrubEvent } from './sentry-scrub';

/**
 * Sentry for the web app (ADR-0005): unexpected errors and a sample of traces, nothing else. No
 * session replay, no logs, no personal data; every event is scrubbed (sentry-scrub.ts) before it
 * leaves. Off unless a DSN is configured, so local runs and tests send nothing.
 */
export function sentryOptions(dsn: string | undefined) {
  return {
    dsn,
    enabled: Boolean(dsn),
    environment:
      process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ??
      process.env.NEXT_PUBLIC_VERCEL_ENV ??
      process.env.NODE_ENV,
    sendDefaultPii: false,
    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.1 : 1.0,
    beforeSend: scrubEvent,
    beforeSendTransaction: scrubEvent,
  };
}
