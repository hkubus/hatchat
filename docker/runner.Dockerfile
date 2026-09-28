FROM node:22-slim

RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm install --no-frozen-lockfile

ENV NODE_ENV=production
ENV HAT_WORKSPACE_ROOT=/srv/hat/workspaces

# No ports: the runner dials out to the server's /link endpoint.
CMD ["pnpm", "run", "start:runner"]
