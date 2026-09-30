FROM node:22-slim

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

# The lockfile, not whatever the registry serves today: reproducible builds.
RUN pnpm install --frozen-lockfile

# Conversations, the master key and uploads live in /app/.hat (a volume in
# docker-compose.yml). The server runs as the image's unprivileged user.
RUN mkdir -p /app/.hat && chown node:node /app/.hat
USER node

ENV NODE_ENV=production
ENV HAT_HOST=0.0.0.0
EXPOSE 8787

# tsx directly, not `pnpm run`: pnpm lives in root's Corepack cache, and tsx
# passes SIGTERM on to the server.
CMD ["node_modules/.bin/tsx", "packages/server/src/index.ts"]
