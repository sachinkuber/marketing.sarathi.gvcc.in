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
- Environment change (2026-10-04, owner instruction): nothing is installed on the owner's laptop. Milestone 1 was first built with Node 24.20.0, gitleaks and the database on the laptop; all of that was removed. The same checks were re-run on the development server in containers and passed. See `docs/dev-environment.md`.

## Phase 1, milestone 2a: Database and isolation

Finished: 2026-10-04. Commits: 3d0ca2c to d3029e7 on branch `m2a-database-isolation`, stacked on `m1-ground` (pull request 1 is not yet merged). Not yet pushed, so no workflow run yet.

| Package | State | Evidence |
|---|---|---|
| 2 Database, roles, isolation | Done | `npm run verify` passed twice in a row on the development server: 18 test files passed, 1 skipped (the model check). The db package alone has 8 files and 53 tests. |

| Acceptance test | State | Evidence |
|---|---|---|
| 2, 3, 4 | Proven | Catalog and behaviour tests in `packages/db/test` (every table with `brand_id` has forced row-level security, one `brand_isolation` policy and brand-carrying foreign keys; no brand set returns nothing; a row cannot be moved to another brand) |
| 5, role rights | Proven | The queue, audit-writer and owner-view roles cannot read any business table. The half about queue row contents waits for milestone 4. |
| 7 | Proven | The lint rule rejects `pg`, `kysely` and `pg-boss` in application code and allows them inside `packages/db` (`lint-rule.test.ts`); `withBrand` is tested on a pool of one connection |
| 1, 6 | Not yet proven | Test 1 covers every API operation and test 6 covers attempt tokens. Both need code from later milestones. |

## Findings

- Rulings on the plan:
  - Task 6, step 4 of the plan allows `grant mkt_definer to mkt_migration` if the migration role cannot change a function's owner. It was needed and is in `0005_functions.sql`.
  - It was not enough. `alter function … owner to mkt_definer` also needs the new owner to hold CREATE on schema `app`, and `0001` gives `mkt_definer` only USAGE, so `0005` failed with "permission denied for schema app" and every test that builds a database failed with it. `0005` now grants CREATE on `app` to `mkt_definer` first and revokes it at the end of the same file. The end state is unchanged: USAGE only, and no run-time role can become `mkt_definer`.
- Test harness: `createTestDatabase()` did not drop its database when a migration failed, so each failing test file left one behind (25 had built up on the server). It now drops the database and rethrows. Checked with a deliberately broken migration, which left none. There is no permanent test for this.
- Cleanup: the 25 leftover `mkt_t_*` databases were dropped. After two full verify runs there are none.
- Differences from the plan: the two rulings and the harness fix above. The development server's address is kept out of the committed plan (`root@<dev-server>`), as in commit `37816e4`.
- Not done from the plan's Task 7: pushing, and confirming the pull request's workflow run passes.

## Phase 1, milestone 2b: Core service and sign-in

Finished: 2026-10-04. Commits: 3379e76 to the final commit of this milestone on branch `m2b-core-and-sign-in` (`git log --oneline main..HEAD`): the plan and its Word copy, then the workspace and configuration, the service shell, the origin check and per-session token, the auth schema and options, sessions and the second-factor gate, invites, second-factor enrolment, recovery, lockout, the second-factor and reset limits, the runnable service, and the fix wave after the final review. The branch has not been pushed and the pull request has not been opened yet, so there is no workflow run yet. The pull request opens after the final review and the owner's approval.

| Package | State | Evidence |
|---|---|---|
| 3 Core service shell | Done | Strict validation, one error envelope, security headers, health endpoints, origin check and per-session token on every state-changing request; `npx vitest run apps/core` passes |
| 4 Sign-in, second factor, invites, recovery | Done | Single-use 72-hour invites, a mandatory second factor with single-use backup codes, password recovery by a single-use 30-minute link, lockout per address for sign-in and recovery and per account (user ID) for the second factor (ruling 5); `npm run verify` passed twice in a row on the development server |

The service now runs: `npm run start --workspace @mkt/core` starts `main.ts` under Node's own type stripping. A smoke run of the same entry path (server, adapters and database, outside Vitest) answered `200` on `/health/ready`.

| Acceptance test | State | Evidence |
|---|---|---|
| 8, through the API gate | Proven | A person who has not enrolled a second factor can reach only the enrolment routes (`enrolment-gate.test.ts`) |
| 9, 10, 11, 12 | Proven | Sign-in, second factor, invites, recovery and lockout tests in `apps/core/test` |
| SEC-1 | Proven | Tested: the disable route answers 403; the same path with a trailing slash or other casing answers 404; update-user cannot change `twoFactorEnabled`; a direct `auth.api.disableTwoFactor` call answers 403; the emailed-code routes (`send-otp`, `verify-otp`) answer 403; the remember-this-device flag (`trustDevice`) answers 403, sets no cookie, and the next sign-in from the same browser still asks for the second factor (`second-factor.test.ts`, `second-factor-routes.test.ts`, `trust-device.test.ts`) |
| No self-registration | Proven | The only way to create an account is an invite |
| 8, the screen side | Not yet proven | Waits for the dashboard |
| 13 | Not yet proven | Belongs to package 5 |
| 1, 6 | Not yet proven | Need code from later milestones |

## Findings

Decisions the owner accepted on 2026-10-04: the five open decisions in the plan were ACCEPTED, and every value the plan proposed (invite lifetime, recovery link lifetime, lockout counts and durations and the rest) was accepted as proposed.

- Rulings (made while building, in plain language):
  1. Account issuer: the generated `auth.account` table requires an `issuer` and has a unique (issuer, account id) index. Better Auth 1.7.2 does not fill it for password accounts, so the code passes `local:credential`, the value the library's own password lookup uses. If wrong: a library upgrade that changes that string breaks sign-in, and the sign-in tests would catch it.
  2. Creating a user needs a second argument in 1.7.2; the code passes `{ method: 'admin' }`. The library only reads it if a user-info hook is set, and none is.
  3. Library logger: the auth options take an optional logger. The test stack passes `{ disabled: true }`; production (changed in the fix wave) sends the library's lines through the service logger, keeping only the message and an error's name and message. If wrong: library warnings are hidden in tests only.
  4. The invite lookup also refuses a caller who is locked on the same address key as invite accept. The plan only counted failures there, which would leave lookup as a free guessing route while accept is locked.
  5. The second-factor lock is keyed per user, not per cookie as the plan said, because the plan's key could be bypassed with an extra cookie or a fresh sign-in; section 7 of the spec is binding. The pending-challenge cookie is resolved in the before hook. A correct password never clears the lock; only a successful second-factor step does.
  6. Recovery: every password-reset request is counted against the address, not only failures as the plan said, because the route always answers 200 and a failure could never happen. The reset step itself stays unlimited because the link carries enough randomness; this is accepted. Cost: a person who asks for more than 5 resets in 15 minutes is locked for that address for 15 minutes.
  7. Accepted risk: someone who holds a person's password can lock that person's second factor for 15 minutes. The per-address sign-in lock already allows the same denial.
  8. SEC-1, other routes: `twoFactorEnabled` is declared as not settable by the user in the plugin schema, so the update-user route cannot change it. The library wraps every endpoint so hooks see the canonical path, and direct calls to the library API pass the same wrapper. Read from the installed library first; the fix wave added the tests listed under SEC-1 above.
  9. Race on invite accept: when two people redeem the same invite at once, the loser gets 409 `account_exists`. It happened in 6 of 6 runs and the test asserts 409.
- Generated auth SQL matched the review checklist: five tables (user, session, account, verification, twoFactor), uuid ids, six indexes, and no drops.
- Eight foreign keys to `auth.user` were added in migration 0006. No older test needed changing.
- Mail timing: the reset-password mail is awaited only for known addresses, so the response time can differ between known and unknown addresses once a real mailer exists. In package 11 either make the send fire-and-forget with failures logged (the library has a background-task handler for this) or accept the difference.
- Deployment precondition (final review I7): Express `trust proxy` cannot be configured yet (no `TRUST_PROXY` variable; `AppDeps.trustProxy` exists), so nothing may be deployed behind the proxy before package 16 sets it, or the invite limiter keys on the proxy's address for everyone. The same applies to any run with `NODE_ENV=production`, proxy or not. Package 16 must also tell Better Auth where the client address is (`advanced.ipAddress`): with NODE_ENV=production the library's own rate limiter warned on the development server that it could not find a client IP and falls back to one shared bucket per path for everyone.
- Open points from the fix-wave re-review, for later packages: `verify-backup-code` with `disableSession` uses up a code without starting a session and records no actor; a real mail transport's error can contain the recipient, so package 11 must log only the error's name and code (the current `onMailFailure` logs the error object, which is safe only for the stand-in mailer); refused requests (the second-factor disable, the emailed-code routes and the remember-this-device flag) are refused before the after hook and so are not audited (package 6); a second Ctrl-C is ignored during shutdown, so a hung shutdown ends only with SIGKILL.
- Migration 0006 now resets `search_path` after the generated SQL (fix wave). Our `migrate()` runs each migration in its own transaction (node-pg-migrate 8.0.4's runner, `singleTransaction` unset), so nothing had leaked; the node-pg-migrate command line runs all pending migrations in one transaction by default, where it would have. A test inventories the `auth` namespace.
- Database connection errors: `createPool` has no error handler on purpose; `startServer` attaches one to both pools and logs the error, so a dropped idle connection (for example when the database restarts) does not crash the process. This is tested by emitting an error on each pool.
- `.env.example` has one live `DATABASE_URL` (the run-time role `mkt_app`); the superuser line is commented out, because the tests fall back to it when `DATABASE_URL` is unset and must not run with the run-time-role URL exported. A test keeps it to one line.
- Mail fails open, the audit sink fails closed (final review C2, controller ruling): a notification that cannot be sent is logged as "mail not sent" (the error only, never the message or the address) and never changes the answer, so a known and an unknown address still look the same and a used backup code still signs the person in. Before the fix a backup-code sign-in answered 500 after using the code up. An audit entry that cannot be written refuses the attempt (500, no session), on purpose.
- Idle timeout (final review I1, confirmed and fixed): the service's own session lookups dropped the cookie the library renews after 5 minutes, so the browser's cookie ended 30 minutes after sign-in however active the person was. `loadPrincipal` now passes it on, and the origin-check lookup reads without refreshing.
- The library no longer writes to the console: its log lines go through the service logger, and an error that is not the library's own reaches the service's error handler instead of being printed by its router. Seen on the development server before the fix: "Reset Password: User not found" and "User not found" on stderr, without the address.
- Follow-ups the final review said may wait, one line each:
  - Someone holding a session can guess the password without limit through `/two-factor/get-totp-uri`, `/two-factor/enable`, `/change-password` and `/two-factor/generate-backup-codes`; the next hardening item.
  - Password change, backup-code regeneration and enrolment are not audited (packages 5 and 6).
  - Package 5 should make the enrolment gate structural (public and gated sub-routers) instead of relying on route order.
  - `createInvite`'s `origin` must come from `config.publicOrigin` in the future invite route, never from a request header.
  - `PUBLIC_ORIGIN` should require https when `NODE_ENV=production`.
  - A TOTP code can be replayed within its 30-second step: the generated `twoFactor` table has no last-used counter.
  - Mail timing side channel (see the mail timing finding) for package 11.
  - Two session lookups per state-changing request (origin check and `loadPrincipal`).
  - pino-http logs every `/health` probe.
- Not proven: test 13 (package 5), tests 1 and 6 (later milestones), and the screen side of test 8 (the dashboard).
- State, plainly: no real email can be sent. Every send fails with "Email delivery is not configured" and is logged as "mail not sent" until notification delivery (package 11), and the audit sink is the log until the audit log (package 6).
- Pull request: not opened yet. Nothing has been pushed.

## Phase 1, milestone 2c: Permissions

Finished: 2026-10-04. Commits: 376d0a0 to the final commit of this milestone on branch `m2c-permissions` (`git log --oneline main..HEAD`): the plan, the owner's decisions and its Word copy, then the role and permission matrix, the route table and the brand check, the route inspection, the code check before a sensitive action, the brand routes, the users routes (list and invite; change a role and remove a person; reset a second factor), and the fix wave after the final review. The branch has not been pushed and the pull request has not been opened yet when this is written, so there is no workflow run yet.

| Package | State | Evidence |
|---|---|---|
| 5 Permissions | Done | Every route is declared in one route table with what it needs; brand routes get the brand check; three sensitive actions ask for the actor's own authenticator code; `npx vitest run apps/core packages/db` passes (43 files, 267 tests) and `npm run verify` passed twice in a row on the development server |

| Acceptance test | State | Evidence |
|---|---|---|
| 13, declaration half | Proven | Over `/api/v1`: every route is in the route table, with a summary; a route added outside the table is detected; the only public routes are the two invite routes, and an allowlist test is the gate for any new public route (`route-declarations.test.ts`, `route-table.test.ts`). Boundary: Better Auth's own routes under `/api/auth` and `/health` are not in the table; the 2b hooks govern the library routes. |
| 13, role half | Proven | A test reads the PRD 16.1 table and compares all 50 cells with the code (`permissions.test.ts`); a second test proves each role is allowed and denied over HTTP for each of the ten permissions, with a probe route each, plus 404 for strangers (`role-matrix.test.ts`) |
| 1, for the routes that exist | Proven | Generically for every route under `/brands/:brandId` that exists now (five routes), by a test that reads the route table, so later brand routes are covered automatically (`cross-brand.test.ts`). The content, approval and agent routes of later milestones are still to come. |
| SEC-2 | Proven for the routes that exist | A route cannot reach the service without a declaration |
| 6 | Not yet proven | Attempt tokens need the worker |
| 8, the screen side | Not yet proven | Waits for the dashboard |

## Findings

The seven owner decisions, accepted on 2026-10-04:

1. Resetting a second factor is the platform owner's alone (spec section 7; app-flow 5.3 also lists it for brand admins: the spec wins).
2. Nobody changes or removes their own membership, and the last brand admin cannot be demoted or removed.
3. Only the platform owner touches a platform owner's membership.
4. Each sensitive action carries the actor's current code; there is no recently-verified window; a code can be reused inside its 30-second window.
5. A stranger to a brand gets 404, a member without the permission 403, and the platform owner any brand that exists.
6. Until real mail (package 11) no invite can really be sent: inviting answers 502 and leaves no invite behind.
7. Removing a person removes the membership in that brand only, ends their sessions if no membership remains, and keeps the account.

- Rulings (made while building, in plain language):
  1. (Task 2, implementer) `RouteDeclaration.handlers` is typed `readonly RequestHandler[]`.
  2. (Task 2, controller) The plan's `includes(':brandId')` check was too weak. Brand scope is decided by path segments: a `brands` segment must be followed by exactly `:brandId` and the route must be member or permission; a member or permission route must start with `/brands/:brandId`. A case-variant `brands` segment and any glued or modified brand parameter (`:brandid`, `:brandId?`) are refused, because Express matches paths case-insensitively.
  3. (Task 3, controller) Route paths may contain only `[A-Za-z0-9_-/:]` (literal segments and plain `:name` parameters), because path-to-regexp v8 syntax (`{}`, `*`, `()`, `?`) could make a path match brand URLs unseen by the segment rule.
  4. (Task 3, controller) The route inspection also reports a sub-router or middleware mounted on the router. The fail-safe tail `router.use(principal, enrolmentGate)` keeps anything registered after build behind a session and a finished enrolment.
  5. (controller) The cross-brand test's floor against an empty route list started at 1 and rose as the users routes arrived (1, 3, 5).
  6. (Task 4, implementer) `Auth` has no plugin endpoint types, so `step-up.ts` uses a local `VerifyTotp` type and a cast (types only; a renamed endpoint fails at runtime with a 500, and the first step-up test catches it). Library behaviour read by the implementer: for a signed-in caller `verifyTOTP` returns the existing token and creates no session; the library's own lockout is skipped for a signed-in caller, so the 429 and the audit entry come from this project's hooks (the in-memory per-account lock, shared with sign-in).
  7. (Tasks 6 and 8, implementer) The tests use one top import block and module-level helper classes instead of inline dynamic imports. Task 8 added one test: 401 without a session and 403 `enrolment_required` for an unenrolled brand admin.
  8. (controller, final review) Inviting needs no second-factor code (spec section 7 and app-flow 5.3 list role change, removal and reset only). Decision for the owner before package 11: once mail works, a stolen brand-admin session could invite an attacker's address as `brand_admin`. Either require the code when the invited role is `brand_admin`, or notify the brand's admins on every invite.
  9. (fix wave) What the fix wave changed, after the final review:
     - An invite taken back after a mail failure is now audited as `users.invite_withdrawn` (same `inviteId`, `reason: mail_not_sent`); the route passes an `onWithdrawn` callback, so `invites.ts` stays free of the audit dependency. If that entry cannot be written, it is reported and the answer is still 502. The compensating delete is guarded: if it fails, the mail error is still reported, and the request answers 500 with an error naming the invite id (logged), the mail error as its cause.
     - The member lock is taken in a fixed order (`order by user_id`), and the actor's authority is checked again inside the lock: an admin demoted or removed by a colleague while their own request is in flight now gets 403, before any other check. A service-level barrier test holds the first change open inside its transaction and shows, through `pg_stat_activity`, that the second waits on the lock and is then refused on the committed state.
     - The code check passes the library's server errors (5xx) on instead of answering "the code is not right"; only 4xx answers become 403 `second_factor_invalid`.
     - The brand ID in the path is read once, in lowercase (an uppercase UUID used to give a member 404 and the owner an uppercase ID in the brand context); the owner's existence check and the brand read name the brand id in the query as well as relying on row-level security.
     - A route path that does not start with `/` is refused.
     - The cross-brand test also refuses a 5xx in the person's own brand, and expects exactly 401 without a session.
- Step-up attribution (checked in the fix wave): the failed code checks before a sensitive action are audited as `auth.second_factor`, outcome failure, with `actor` set to the signed-in person's id (the after hook takes the actor from the session on the request). Failed second-factor steps during sign-in, where there is only a pending challenge and no session, and every `auth.locked_out` entry (the 429), are recorded with `actor: null`.
- Follow-ups, one line each:
  - Production today: every invite answers 502 until package 11 (stand-in mailer), and now leaves `users.invited` followed by `users.invite_withdrawn` in the audit trail.
  - Package 6: `AuditSink.record` takes no transaction client, so the invite, role, removal and reset changes and their audit entries are atomic only in the fail-closed direction (an audit that cannot be written rolls the change back; a failed COMMIT after a written entry could over-report). The real sink must take the transaction client. Failed second-factor steps during sign-in and lockout entries carry `actor: null` (see step-up attribution above).
  - Package 11: redact mailer errors (log the error's name and code only; the current `onMailFailure` logs the error object); the mail-timing side channel; decide the invite code rule (ruling 8).
  - Deployment (package 16): the proxy must pass DELETE request bodies (the code is sent in the body); the 2b preconditions stand (trust proxy, the library's client address); the in-memory lockout resets on restart.
  - Dashboard milestone: `GET /brands` reports the membership role while `GET /brands/:brandId` reports `platform_owner` for an owner who is also a member; the owner's list of all brands needs the owner-view database role and an audit entry per call; the kill switch and data export will reuse `verifySecondFactorCode` exactly as the three routes do (authorise, then code, then change).
  - Not done on purpose: cancelling a pending invite; adding an existing account to a second brand (accept answers 409); TOTP replay inside 30 seconds.
  - Test caveats: the two-admin HTTP concurrency test is probabilistic (the fix wave added the deterministic service-level barrier test); several users tests share state and run in order; the log-lacks-address assertions are vacuous for the stand-in mailer.
  - Product note: after a second-factor reset, anyone who holds the person's password can sign in and enrol their own second factor; the email notification and the session kill are the mitigation (spec design).
  - Deferred minors (cosmetic or later): TypeScript typing of `authOptions` (would remove the `VerifyTotp` cast); an unflagged client release after a failed rollback in `withBrand` and in `removeMember` and `resetSecondFactor` (fix both in `packages/db` later); a user ID in the path is still compared as written (an uppercase user UUID answers 404); test assertion polish.
- Pull request: not opened yet. Nothing has been pushed.
