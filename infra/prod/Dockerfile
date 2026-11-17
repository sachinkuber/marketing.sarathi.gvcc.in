# Production images: core, worker, dashboard and ops, from one pinned Node base (plan, Task 4).
# Build from the repository root, one target at a time (the host's processors are shared):
#   docker build -f infra/prod/Dockerfile --target core -t <name> .
# The ignore file is infra/prod/Dockerfile.dockerignore (BuildKit reads <Dockerfile>.dockerignore).
# No secret is used at build time: configuration and passwords reach the containers at start, from env files.
# Node runs the TypeScript sources directly (type stripping), with no flags.

# ---- base: the Node image of infra/dev/server-run.sh, by digest. Every app image runs as `node` (uid 1000).
FROM node:24.20.0@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2 AS base
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
# The command runs as it is written (no docker-entrypoint.sh in between): node is the first process.
ENTRYPOINT []
USER node

# ---- manifests: every workspace's package.json, so `npm ci` can check the lockfile.
FROM base AS manifests
USER root
COPY package.json package-lock.json .npmrc ./
COPY apps/core/package.json apps/core/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
COPY apps/ops/package.json apps/ops/
COPY packages/canonical/package.json packages/canonical/
COPY packages/db/package.json packages/db/
COPY packages/queue/package.json packages/queue/
COPY packages/queue-contract/package.json packages/queue-contract/
COPY packages/shared/package.json packages/shared/
COPY packages/stack-check/package.json packages/stack-check/
COPY packages/test-support/package.json packages/test-support/

# ---- production dependencies of each target, no dev dependencies and no install scripts.
FROM manifests AS core-deps
RUN npm ci --omit=dev --ignore-scripts --workspace @mkt/core && rm -rf /root/.npm

FROM manifests AS worker-deps
RUN npm ci --omit=dev --ignore-scripts --workspace @mkt/worker && rm -rf /root/.npm

FROM manifests AS ops-deps
RUN npm ci --omit=dev --ignore-scripts --workspace @mkt/ops && rm -rf /root/.npm

# ---- core
FROM base AS core
COPY --from=core-deps /app/node_modules node_modules
COPY package.json ./
COPY packages/canonical packages/canonical
COPY packages/db packages/db
COPY packages/queue packages/queue
COPY packages/shared packages/shared
COPY packages/test-support packages/test-support
COPY apps/core apps/core
EXPOSE 4000
CMD ["node", "apps/core/src/main.ts"]

# ---- worker
FROM base AS worker
COPY --from=worker-deps /app/node_modules node_modules
COPY package.json ./
COPY packages/queue packages/queue
COPY packages/shared packages/shared
# The worker reads the agent's prompt, model and schema from here when it starts.
COPY agents agents
COPY apps/worker apps/worker
CMD ["node", "apps/worker/src/main.ts"]

# ---- dashboard: built here, then only the standalone server, its static files and public are kept.
FROM manifests AS dashboard-build
RUN npm ci --include=dev --ignore-scripts --workspace @mkt/dashboard --include-workspace-root \
  && rm -rf /root/.npm
COPY tsconfig.base.json ./
COPY apps/dashboard apps/dashboard
# A reverse proxy routes /api to the core in production (apps/dashboard/api-routing.ts).
RUN mkdir -p apps/dashboard/public \
  && DASHBOARD_PROXY_ROUTES_API=1 npm run build --workspace @mkt/dashboard

FROM base AS dashboard
COPY --from=dashboard-build /app/apps/dashboard/.next/standalone ./
COPY --from=dashboard-build /app/apps/dashboard/.next/static apps/dashboard/.next/static
COPY --from=dashboard-build /app/apps/dashboard/public apps/dashboard/public
ENV PORT=3000 HOSTNAME=0.0.0.0
EXPOSE 3000
CMD ["node", "apps/dashboard/server.js"]

# ---- ops tools, each pinned by version and checksum.
#   age 1.3.2:     sha256 from the GitHub release asset digest of age-v1.3.2-linux-amd64.tar.gz.
#   rclone 1.75.2: sha256 from the release's signed SHA256SUMS.
FROM base AS ops-tools
USER root
RUN set -eu; cd /tmp; \
  curl -fsSLo age.tar.gz https://github.com/FiloSottile/age/releases/download/v1.3.2/age-v1.3.2-linux-amd64.tar.gz; \
  echo 'cbe24006683f8eb669266162894b9a522a1af52f2665fbc63a4bb032ed26ac10  age.tar.gz' | sha256sum -c -; \
  tar -xzf age.tar.gz age/age age/age-keygen; \
  curl -fsSLo rclone.zip https://github.com/rclone/rclone/releases/download/v1.75.2/rclone-v1.75.2-linux-amd64.zip; \
  echo '349ac8fba6ff65d6247043f1750cdcb518ec5d500ef91463a10d37c0ccdf3702  rclone.zip' | sha256sum -c -; \
  unzip -q -j rclone.zip rclone-v1.75.2-linux-amd64/rclone -d rclone; \
  mkdir /out; mv age/age age/age-keygen rclone/rclone /out/; chmod 0755 /out/*

# ---- ops: migrations, role passwords and the queue (`prepare`), plus the backup tools.
# postgresql-client-17 comes from the PostgreSQL project's archive repository (every version stays there),
# signed by the key with fingerprint B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8, checked before it is trusted.
# The archive also holds betas and release candidates, so every package taken from it is pinned: the client
# 17.11 (2026-08-13) and, from the same release day, libpq 18.6 (libpq-dev comes with the base image and must
# match libpq5) and postgresql-client-common 293 (2026-07-16).
FROM base AS ops
USER root
RUN set -eu; \
  curl -fsSLo /tmp/pgdg.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc; \
  test "$(gpg --show-keys --with-colons /tmp/pgdg.asc | awk -F: '$1 == "fpr" { print $10 }')" \
    = 'B97B0AFCAA1A47F044F244A07FCC7D46ACCC4CF8'; \
  gpg --dearmor -o /usr/share/keyrings/pgdg.gpg /tmp/pgdg.asc; rm -rf /tmp/pgdg.asc /root/.gnupg; \
  echo 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt-archive.postgresql.org/pub/repos/apt bookworm-pgdg-archive main' \
    > /etc/apt/sources.list.d/pgdg.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends postgresql-client-17=17.11-1.pgdg12+2 \
    libpq5=18.6-1.pgdg12+2 libpq-dev=18.6-1.pgdg12+2 postgresql-client-common=293.pgdg12+1; \
  rm -rf /var/lib/apt/lists/*
COPY --from=ops-tools /out/ /usr/local/bin/
COPY --from=ops-deps /app/node_modules node_modules
COPY package.json ./
COPY packages/db packages/db
COPY packages/queue packages/queue
COPY packages/test-support packages/test-support
COPY apps/ops apps/ops
USER node
ENTRYPOINT ["node", "apps/ops/src/main.ts"]
CMD ["prepare"]
