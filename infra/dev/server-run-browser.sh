#!/bin/sh
# Runs a command in the browser image (infra/dev/browser.Dockerfile) against the project copy on the
# development server. Like server-run.sh, with 3 GB for Chromium (plan decision 2).
# Installed on the server as /opt/mkt-dev/server-run-browser.sh.
# Usage: /opt/mkt-dev/server-run-browser.sh "npm ci && npm run e2e"
exec docker run --rm --name "mkt-dev-browser-run-$$" --network host --memory 3g --cpus 1.5 --shm-size 256m \
  -v /opt/mkt-dev/marketing:/work -v /opt/mkt-dev/bin/gitleaks:/usr/local/bin/gitleaks:ro \
  -e HOME=/tmp -w /work mkt-dev-browser:1 sh -c "git config --global --add safe.directory /work && $*"
