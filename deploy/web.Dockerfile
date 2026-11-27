# TipMe web image (Next.js standalone), served on the server behind the edge Caddy since Vercel
# paused the project (26 Nov 2026). The API and worker image is deploy/Dockerfile.
#
# Built once per environment, because the browser's settings are baked in at build time: the
# deploy workflows pass them as build args (names only here; values come from GitHub variables).
#   docker build -f deploy/web.Dockerfile \
#     --build-arg TIPME_BUILD_VERSION=<sha> --build-arg SITE_URL=https://www.example.com \
#     --build-arg NEXT_PUBLIC_API_ORIGIN=https://api.example.com ... -t tipme-web-<env>:<sha> .
# Server-only settings (secrets, the preview password, the API's internal address) are never build
# args: they come from the server's env file at run time (deploy/compose.*.yml).

FROM node:24.22.0-alpine AS base
ENV PNPM_HOME=/pnpm CI=true NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Only the packages the web app needs, with a lockfile cut to match.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.9 prune @tipme/web --docker

FROM base AS build
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ ./
# The build's identity: /api/version answers it, and the deploy waits for exactly this value.
ARG TIPME_BUILD_VERSION
# Pages Next prerenders at build (robots.txt, sitemap.xml, marketing metadata, canonical links)
# read these, so they are build values; the runtime stage keeps the same ones.
ARG SITE_URL
ARG SITE_INDEXING=
# The browser's settings, inlined into the client bundles.
ARG NEXT_PUBLIC_API_ORIGIN
ARG NEXT_PUBLIC_PREVIEW_GATE=
ARG NEXT_PUBLIC_SENTRY_DSN=
ARG NEXT_PUBLIC_SENTRY_ENVIRONMENT=
ARG NEXT_PUBLIC_PRETEND_DELIVERY=
RUN for name in TIPME_BUILD_VERSION SITE_URL NEXT_PUBLIC_API_ORIGIN; do \
      eval "value=\${$name}"; \
      [ -n "$value" ] || { echo "Build arg $name is required." >&2; exit 1; }; \
    done
# The edge compresses (zstd, gzip), so this build's Next does not (apps/web/src/lib/edge-compression.ts).
ENV TIPME_EDGE_COMPRESSES=on
RUN pnpm turbo run build --filter=@tipme/web

FROM node:24.22.0-alpine AS web
RUN apk add --no-cache tini
ARG SITE_URL
ARG SITE_INDEXING=
# HOSTNAME: Docker sets it to the container id, and the standalone server listens on it.
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000 \
    SITE_URL=$SITE_URL SITE_INDEXING=$SITE_INDEXING
WORKDIR /app
# Owned by root, so the server (user node) cannot change its own code; only the cache is writable
# (a tmpfs in Compose, whose root filesystem is read-only).
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public
RUN mkdir -p apps/web/.next/cache && chown node:node apps/web/.next/cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=10s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/version').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "apps/web/server.js"]
