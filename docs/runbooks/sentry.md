# Sentry

Unexpected errors from staging (and later production) go to the Sentry organization **`tipme-fs`** (EU region, `de.sentry.io`).

| Project         | What reports to it              | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tipme-backend` | API and worker                  | TipMe's own reporter (`packages/observability/src/error-reporter.ts`): error type, stack frames, service, route or job, trace id, release, environment. Never the message, request, cookies, headers or user.                                                                                                                                                                                                                                                                                  |
| `tipme-web`     | Web app (browser, server, edge) | `@sentry/nextjs`: errors and 10% of traces. No session replay, no Sentry logs, no personal data. Every event passes `scrubEvent` (`apps/web/src/lib/sentry-scrub.ts`): URLs lose their query string and fragment (receipt links carry the status token), user, cookies, headers and request bodies are removed, console and form-input breadcrumbs are dropped. Browser reports go through `/sentry-tunnel` on the site, so the Content Security Policy stays limited to the site and the API. |

DSNs are public client keys (they only allow sending events), so they live in plain settings.

## Settings

| Where                                    | Setting                                   | Value                                                                                                                                                                                                 |
| ---------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Staging server, `/srv/tipme/staging.env` | `SENTRY_DSN`                              | the `tipme-backend` DSN (set 28 October 2026)                                                                                                                                                         |
| Staging server                           | `SENTRY_ENVIRONMENT`                      | optional; defaults to `staging` on a preview copy                                                                                                                                                     |
| Vercel, web project                      | `NEXT_PUBLIC_SENTRY_DSN` and `SENTRY_DSN` | the `tipme-web` DSN                                                                                                                                                                                   |
| Vercel                                   | `NEXT_PUBLIC_SENTRY_ENVIRONMENT`          | `staging` for the staging deployment, `production` later                                                                                                                                              |
| Vercel                                   | `SENTRY_AUTH_TOKEN`                       | an organization auth token (Sentry → Settings → Auth Tokens, scope `project:releases`), so each build uploads source maps and deletes them from the deployment; without it stack traces stay minified |

Without a DSN nothing is sent: local runs, CI and the e2e suite report nothing.

## One organization setting

Sentry infers the sender's IP address from the request even when the SDK sends none. Turn on **Settings → Security & Privacy → Prevent Storing of IP Addresses** for `tipme-fs` (verified 28 October 2026: without it, test events showed an IP).

## Checking that it works

- Backend: after a deploy, an unexpected API or worker error appears in `tipme-backend` tagged with the release (the git SHA) and `environment: staging`.
- Web: an unhandled error on any page appears in `tipme-web`; the event's URL has no query string.
