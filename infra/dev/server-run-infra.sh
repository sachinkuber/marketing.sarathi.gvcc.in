#!/bin/sh
# Runs a command in the infrastructure image (infra/dev/infra.Dockerfile: the Node image plus the Docker CLI
# and its buildx and Compose plugins) against the project copy on the development server, for the tests in
# infra/prod/test that build and start images. Same cap as server-run.sh (2 GB, 1.5 CPUs); the image builds
# themselves run in the host's Docker.
# The Docker socket is mounted: the container can do anything root can do on the host. Development server
# only, for the owner's own sessions; never in production or CI.
# Installed on the server as /opt/mkt-dev/server-run-infra.sh.
# Usage: /opt/mkt-dev/server-run-infra.sh "node --test infra/prod/test/images.test.mjs"
exec docker run --rm --name "mkt-dev-infra-run-$$" --network host --memory 2g --cpus 1.5 \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /opt/mkt-dev/marketing:/work -v /opt/mkt-dev/bin/gitleaks:/usr/local/bin/gitleaks:ro \
  -e HOME=/tmp -w /work mkt-dev-infra:2 sh -c "git config --global --add safe.directory /work && $*"
