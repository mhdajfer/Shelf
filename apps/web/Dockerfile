# Build from the repository root, so the workspace packages are in the context:
#   docker build -f apps/web/Dockerfile -t shelf-web \
#     --build-arg PUBLIC_WEB_URL=https://shelf.example \
#     --build-arg PUBLIC_API_URL=https://shelf.example .
#
# The root .dockerignore leaves apps/web out for the API image, so this file has
# its own beside it: Dockerfile.dockerignore.

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Dependencies first, from the manifests alone, so this layer is reused until a
# manifest or the lockfile changes.
FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY apps/web/package.json apps/web/
COPY packages/config/package.json packages/config/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shelf/web...

COPY apps/web apps/web
COPY packages/config packages/config
COPY packages/shared packages/shared

# next.config.ts inlines these into the bundle, so they are fixed when the image
# is built: changing one means building again.
ARG PUBLIC_WEB_URL
ARG PUBLIC_API_URL
# Where server components reach the API, when that differs from the public URL.
ARG API_INTERNAL_URL
ARG TURNSTILE_SITE_KEY
ENV PUBLIC_WEB_URL=$PUBLIC_WEB_URL \
    PUBLIC_API_URL=$PUBLIC_API_URL \
    API_INTERNAL_URL=$API_INTERNAL_URL \
    TURNSTILE_SITE_KEY=$TURNSTILE_SITE_KEY
RUN pnpm --filter @shelf/web... build

# The whole workspace, not a pruned copy: `next start` reads next.config.ts, and
# loading a TypeScript config needs the dev dependencies that compiled it.
FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Unprivileged. The image ships a "node" user for this; it owns the tree because
# Next writes its cache under .next.
COPY --from=build --chown=node:node /repo /repo
WORKDIR /repo/apps/web
USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/robots.txt').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["node_modules/.bin/next", "start", "--hostname", "0.0.0.0", "--port", "3000"]
