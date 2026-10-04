# Progress

## Phase 1, milestone 1: Ground

Finished: 2026-10-04. Commit: 37df364 (checks workflow run 1, passed; pull request 1, awaiting the owner's review before merge).

| Package | State | Evidence |
|---|---|---|
| 0 Stack trial and version pinning | Done | `npm run verify` passes on Node 24.20.0, npm 11.19.0 |
| 1 Repository, build, tests, lint, secret scanning | Done | Workflow run 1 passed |

| Acceptance test | State | Evidence |
|---|---|---|
| 39, for the repository | Proven | `npm run secrets`: no leaks in the history |

## Findings

- Installer: the full pinned set installs on Node 24.20.0 with npm 11.19.0 with no resolution error. The `edgesOut` crash seen on Node 22 with npm 10.9.8 did not occur. No flag was needed.
- Secret scanner: gitleaks 8.30.1 installed, as planned. It does not flag the development database password.
- Model check: skipped, because no `ANTHROPIC_API_KEY` is available (owner item A3). The type-check of `output_config` passes, so the pinned SDK has that field.
- Security advisories on the pinned set (`npm audit`): `next` 16.3.4 has a critical advisory (remote code execution in `next/og` ImageResponse; fixed in 16.3.8, same major) and `nodemailer` 9.1.1 has a high one (a process-wide DNS cache reuses the TLS server name across transports; fixed in 10.0.14, a new major version). The pins were not changed. Milestone 1 uses neither library. Owner decision needed before Phase 1 uses them.
- Deviations from the plan: the executor's scratch folder `.superpowers/` was added to `.gitignore`; `.env.*` in `.gitignore` hid `.env.example`, so `!.env.example` was added; a local variable named `crypto` in `tools/build-docs/md2docx.js` was renamed because it shadows a Node global. Work was done on branch `m1-ground` with a pull request, not on `main`, so the checks ran before anything was merged.
