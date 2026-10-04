# Development environment

Nothing is installed on the owner's laptop. All development, testing and staging work runs on the development server, in containers. The server's address and login are kept in the owner's private notes, not in this repository.

- Project copy: `/opt/mkt-dev/marketing`, synced from the laptop with `rsync` (without `node_modules`).
- Commands: `/opt/mkt-dev/run.sh "<command>"` runs the command in the `node:24.20.0` image (Node 24.20.0, npm 11.19.0), limited to 2 GB of memory and 1.5 CPUs. The script is `infra/dev/server-run.sh`.
- Database: the compose project `mkt-dev` (`infra/dev/compose.yaml`), PostgreSQL 17.11 by digest, bound to `127.0.0.1:54329` on the server only. Start it on the server with `docker compose -f infra/dev/compose.yaml up -d --wait`.
- Secret scanner: gitleaks 8.30.1 at `/opt/mkt-dev/bin/gitleaks`, checksum verified.
- Shared host: the server also runs Aztek staging and other projects, with little free memory. Keep containers capped and do not touch other projects' folders or containers.
- Checks: `/opt/mkt-dev/run.sh "npm ci && npm run verify"` passed on 2026-10-04 (63 tests passed, 1 skipped: the model check, which needs an API key).
