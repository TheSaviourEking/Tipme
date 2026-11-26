# Web deployment (self-hosted)

Since 26 November 2026 the website runs on TipMe's own server, beside the API, behind the one edge
Caddy. (Until then it ran on Vercel, which paused the project for exceeding the free plan's compute.)
The one-time move is in `docs/runbooks/staging-setup.md` and `docs/runbooks/production.md`, "Website
on this server".

| Copy       | Address                        | Built and shipped by        | Image                        | Runs as                                        |
| ---------- | ------------------------------ | --------------------------- | ---------------------------- | ---------------------------------------------- |
| Staging    | `https://staging.usetipme.xyz` | Deploy staging (from `dev`) | `tipme-web-staging:<sha>`    | `web` in `tipme-staging`                       |
| Production | `https://www.usetipme.xyz`     | Deploy production (`main`)  | `tipme-web-production:<sha>` | `web-blue` / `web-green` in `tipme-production` |
| (apex)     | `https://usetipme.xyz`         | the edge                    | none                         | a permanent (308) redirect to the www address  |

## How a build becomes a running site

1. The deploy workflow builds `deploy/web.Dockerfile` once, with that environment's build args, as
   `tipme-web-<env>:<12-character sha>`, beside the API's `tipme-app:<sha>`. The server never builds.
2. `scripts/ship-*.sh` sends both images over SSH in one stream, and the version's deploy files.
3. `deploy.sh` (staging) starts `web` with the API; `deploy-production.sh` starts the idle colour's
   API and website together. The deploy waits until the website's public address answers
   `/api/version` with the new sha, then (production) stops the old colour.
4. A rollback moves the website with the API: each version's website is that version's image.

The image is Next.js `output: 'standalone'` (`node apps/web/server.js`, port 3000), run as `node`
with code owned by root, a read-only root filesystem and two bounded tmpfs mounts (the image cache,
`.next/cache`, and regenerated pages, `.next/server/route-cache`). Caches are in memory per copy:
the API's `/api/revalidate` call refreshes the copy that receives it, and any other copy (only
during a production switch) refreshes within 30 seconds on its own.

## Settings

**Build-time** (baked in; a change needs a new build, so a redeploy). From GitHub variables; none
is a secret.

| Build arg                        | Staging (variable, default)                       | Production (variable, default)                          |
| -------------------------------- | ------------------------------------------------- | ------------------------------------------------------- |
| `TIPME_BUILD_VERSION`            | the deployed sha                                  | the deployed sha                                        |
| `SITE_URL`                       | `STAGING_WEB_URL`                                 | `PRODUCTION_SITE_URL` (required, the www address)       |
| `SITE_INDEXING`                  | always blank (never indexed)                      | `PRODUCTION_SITE_INDEXING`, blank (off)                 |
| `NEXT_PUBLIC_API_ORIGIN`         | `STAGING_API_URL`                                 | `PRODUCTION_API_URL`                                    |
| `NEXT_PUBLIC_PREVIEW_GATE`       | `STAGING_NEXT_PUBLIC_PREVIEW_GATE`, `on`          | always blank                                            |
| `NEXT_PUBLIC_PRETEND_DELIVERY`   | `STAGING_NEXT_PUBLIC_PRETEND_DELIVERY`, `on`      | always blank (on, it opens `/dev/inbox`)                |
| `NEXT_PUBLIC_SENTRY_DSN`         | `STAGING_NEXT_PUBLIC_SENTRY_DSN`, blank (off)     | `PRODUCTION_NEXT_PUBLIC_SENTRY_DSN`, blank (off)        |
| `NEXT_PUBLIC_SENTRY_ENVIRONMENT` | `STAGING_NEXT_PUBLIC_SENTRY_ENVIRONMENT`, staging | `PRODUCTION_NEXT_PUBLIC_SENTRY_ENVIRONMENT`, production |

`SITE_URL` and `SITE_INDEXING` are build values because Next prerenders `robots.txt`, the sitemap and
the marketing pages' metadata at build. The image keeps the same two in its runtime environment, so
build and run time cannot disagree. The web server's Sentry uses the baked `NEXT_PUBLIC_SENTRY_DSN`
(the `tipme-web` project, never the API's `SENTRY_DSN`). Source maps are not uploaded (that needs
`SENTRY_AUTH_TOKEN` at build, not wired yet), so web stack traces in Sentry are minified.

**Run-time** (the server's env file, read by Compose: `deploy/compose.staging.yml`,
`deploy/compose.production.yml`):

| Setting                 | Staging                              | Production                 |
| ----------------------- | ------------------------------------ | -------------------------- |
| `WEB_REVALIDATE_SECRET` | required (the API's value)           | required (the API's value) |
| `PREVIEW_PASSWORD`      | the API's value                      | never passed               |
| `PREVIEW_COOKIE_DOMAIN` | the API's value                      | never passed               |
| `API_INTERNAL_ORIGIN`   | fixed `http://staging-api:4000`      | not set: the public API    |
| `PILOT_NOTICE`          | optional, deprecated (set in admin)  | optional, deprecated       |
| `PRODUCTION_LAUNCH_AT`  | passed only when its line is present | passed only when present   |

- **Why staging and production reach the API differently:** staging's API has one stable name on the
  edge network (`staging-api`). Production's API is six colour-specific names, and only the edge
  knows which copies are ready, so production's web server goes through the edge at the public API
  address.
- **`WEB_REVALIDATE_URL` stays the public `https://<web host>/api/revalidate`** (blank in
  production means `WEB_ORIGIN/api/revalidate`). The worker is not on the edge network, and in
  production the edge knows which website colour serves, so the public address is the one URL that
  reaches the right copy from both the API and the worker, with no new network paths.

## The pilot notice and launch time: set in admin

Staff set both at `/ops/switches`, "What the web app shows" (owner, 14 Nov 2026, #216). The web
reads them from the API's `/health/release` (each instance at most once a minute). Until a setting is
first set there, the web reads its old variable (`PILOT_NOTICE`, `PRODUCTION_LAUNCH_AT`) from the
server's env file; once both are set in admin, delete those lines. A blank `PRODUCTION_LAUNCH_AT`
would be a malformed launch time, so Compose passes it only when its line exists. See
`docs/runbooks/settings-and-switches.md`.

## Vercel

The Vercel project and `apps/web/vercel.json` are no longer used. Remove both in a later change,
once the self-hosted site has run for a while (keep the Vercel project paused, not deleted, until
then). The 27 October 2026 countdown ran there; its checks (each URL `no-store` and `noindex` before
the instant, both hostnames after) still describe how a future countdown set in admin behaves.
