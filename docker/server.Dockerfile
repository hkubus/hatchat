FROM node:22-slim

RUN corepack enable

WORKDIR /app

COPY package.json pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

RUN pnpm install --no-frozen-lockfile

ENV NODE_ENV=production
ENV HAT_HOST=0.0.0.0
EXPOSE 8787

CMD ["pnpm", "run", "start:server"]
