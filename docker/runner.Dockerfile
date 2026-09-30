FROM node:22-slim

RUN corepack enable
RUN apt-get update \
  && apt-get install -y --no-install-recommends git python3 ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web

# The lockfile, not whatever the registry serves today: reproducible builds.
RUN pnpm install --frozen-lockfile

# The runner executes the model's commands, so it runs as the image's
# unprivileged user rather than root, and owns only its workspaces. The
# entrypoint starts as root only to give an older, root-owned workspaces volume
# to that user, then drops to it (setpriv) before the runner starts.
RUN mkdir -p /srv/hat/workspaces && chown -R node:node /srv/hat
COPY docker/runner-entrypoint.sh /usr/local/bin/hat-runner-entrypoint
RUN chmod 755 /usr/local/bin/hat-runner-entrypoint
ENTRYPOINT ["/usr/local/bin/hat-runner-entrypoint"]

ENV NODE_ENV=production
ENV HAT_WORKSPACE_ROOT=/srv/hat/workspaces

# No ports: the runner dials out to the server's /link endpoint.

# tsx directly, not `pnpm run`: pnpm lives in root's Corepack cache, and tsx
# passes SIGTERM on to the runner.
CMD ["node_modules/.bin/tsx", "packages/runner/src/index.ts"]
