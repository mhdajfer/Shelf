# Build from the repository root, so the workspace packages are in the context:
#   docker build -f apps/api/Dockerfile -t shelf-api .

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# Dependencies first, from the manifests alone, so this layer is reused until a
# manifest or the lockfile changes.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/api/package.json apps/api/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shelf/api...

COPY apps/api apps/api
COPY packages packages
RUN pnpm --filter @shelf/api... build

# The API with production dependencies only, in a self-contained directory.
RUN pnpm --filter @shelf/api deploy --prod --legacy /out

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /out .

# Unprivileged. The image ships a "node" user for this.
USER node
EXPOSE 4000

# The health route checks Postgres and Redis and answers 503 when either is down.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.API_PORT || 4000) + '/api/v1/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Migrations are forward-only and idempotent, so running them at boot is safe
# with more than one instance: the second one finds nothing to do.
CMD ["sh", "-c", "node dist/migrate.js && node dist/index.js"]
