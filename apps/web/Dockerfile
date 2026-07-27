FROM node:24 AS base
RUN npm install -g pnpm@11
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
RUN --mount=type=cache,target=/pnpm-store pnpm install --store-dir /pnpm-store

ENV NODE_ENV=production
RUN cd apps/web && pnpm run build
ENV SKIP_ENV_VALIDATION=

# Bind all interfaces inside the container so the Dokploy/traefik reverse proxy
# can reach it; the docker-compose file uses `expose:` (not `ports:`) so this is
# reachable only on the docker network, never published on a host interface.
ENV HOST=0.0.0.0
ENV PORT=9000
EXPOSE 9000

# SSR chunks require() externals at runtime; must run from the workspace
WORKDIR /app/apps/web
CMD ["node", ".output/server/index.mjs"]
