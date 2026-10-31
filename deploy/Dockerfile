# TipMe API and worker image (PR-010). One image, three uses: api, worker, and tools
# (migrate, backup, restore drill). The web app is built and served by Vercel, not here.
# Built on the server from a git commit: docker build -f deploy/Dockerfile -t tipme-app:<sha> .

FROM node:24.22.0-alpine AS base
ENV PNPM_HOME=/pnpm CI=true NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Only the packages the API and worker need, with a lockfile cut to match.
FROM base AS prune
COPY . .
RUN pnpm dlx turbo@2.11.9 prune @tipme/api @tipme/worker --docker

FROM base AS build
COPY --from=prune /repo/out/json/ ./
COPY --from=prune /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=prune /repo/out/full/ ./
RUN pnpm turbo run build --filter=@tipme/api --filter=@tipme/worker \
 && pnpm install --frozen-lockfile --prod --offline

FROM node:24.22.0-alpine AS runtime
# pg_dump/pg_restore for backups and the restore drill (matches the Postgres 16 server).
RUN apk add --no-cache postgresql16-client=~16 tini
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build --chown=node:node /repo ./
# The backup and retention loops live outside the pruned workspace.
COPY --chown=node:node deploy/backup-loop.sh ./deploy/backup-loop.sh
COPY --chown=node:node deploy/retention-loop.sh ./deploy/retention-loop.sh
USER node
ENTRYPOINT ["/sbin/tini", "--"]
# The compose file chooses the command per service.
CMD ["node", "--import", "./apps/api/dist/instrument.js", "apps/api/dist/main.js"]
