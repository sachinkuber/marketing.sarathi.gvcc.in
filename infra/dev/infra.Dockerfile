# The Node image of infra/dev/server-run.sh (node:24.20.0, pinned by digest) plus the Docker command-line
# client with its buildx and Compose plugins, for the infrastructure tests (infra/prod/test). The host has no Node and nothing is installed on it;
# these tests reach the host's Docker through its socket. Built once on the development server:
#   docker build -f infra/dev/infra.Dockerfile -t mkt-dev-infra:2 infra/dev
# Docker CLI 29.9.1 (2026-10-14): download.docker.com publishes no checksum for 29.9.x static archives;
#   the sha256 below was computed on the first download. Only the `docker` binary is kept.
# buildx 0.38.0 (2026-10-07): sha256 from the release's checksums.txt. `docker build` needs it for BuildKit
#   (per-Dockerfile ignore files, building only the stages a target needs).
# Compose 5.6.0 (2026-10-02, the newest release at least 30 days old on 2026-11-17; the host runs 5.7.1):
#   sha256 from the release's checksums.txt (the same value as GitHub's digest of the release asset).
#   The compose tests (infra/prod/test/compose.test.mjs, stack.test.mjs) need `docker compose`.
# Change a version together with its checksum and the image tag.
FROM node:24.20.0@sha256:be23f54a88d34e8824c741b19b91064094f92c1c97b194144bfc8b50d67258e2
RUN set -eu; cd /tmp; \
  curl -fsSLo docker.tgz https://download.docker.com/linux/static/stable/x86_64/docker-29.9.1.tgz; \
  echo 'c158ecc55adb3afb01bbd3539ed3b997d20c26dbdc418080506cc1bf5243ff57  docker.tgz' | sha256sum -c -; \
  tar -xzf docker.tgz docker/docker; mv docker/docker /usr/local/bin/docker; rm -rf docker docker.tgz; \
  mkdir -p /usr/local/lib/docker/cli-plugins; \
  curl -fsSLo /usr/local/lib/docker/cli-plugins/docker-buildx \
    https://github.com/docker/buildx/releases/download/v0.38.0/buildx-v0.38.0.linux-amd64; \
  echo '4fe4cc38adf48169132749b6ca22a990928db0118e3407584ee553723115d287  /usr/local/lib/docker/cli-plugins/docker-buildx' \
    | sha256sum -c -; \
  curl -fsSLo /usr/local/lib/docker/cli-plugins/docker-compose \
    https://github.com/docker/compose/releases/download/v5.6.0/docker-compose-linux-x86_64; \
  echo '40343e21ca777173e69cff5dbafeb37c6f81f3b0d57d9e597f036e95eb63e76a  /usr/local/lib/docker/cli-plugins/docker-compose' \
    | sha256sum -c -; \
  chmod 0755 /usr/local/bin/docker /usr/local/lib/docker/cli-plugins/docker-buildx \
    /usr/local/lib/docker/cli-plugins/docker-compose
