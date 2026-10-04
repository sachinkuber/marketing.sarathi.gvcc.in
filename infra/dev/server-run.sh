#!/bin/sh
# Runs a command in the pinned Node image against the project copy on the development server.
# Nothing is installed on the host. Installed on the server as /opt/mkt-dev/run.sh.
# Usage: /opt/mkt-dev/run.sh "npm ci && npm run verify"
exec docker run --rm --network host --memory 2g --cpus 1.5 \
  -v /opt/mkt-dev/marketing:/work -v /opt/mkt-dev/bin/gitleaks:/usr/local/bin/gitleaks:ro \
  -e HOME=/tmp -w /work node:24.20.0 sh -c "git config --global --add safe.directory /work && $*"
