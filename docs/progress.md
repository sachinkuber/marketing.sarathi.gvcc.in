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

## Phase 1, milestone 3: Trust

Finished: 2026-10-13 (built 2026-10-08). Branch `m3-trust`, commits 1ef0c56 to 5479c1d (`git log --oneline main..HEAD`, 13 commits): the plan, the content payload schema, canonical text and the `cv1` hash (with a fix refusing a backslash in a link), the content-version integrity triggers, the audit log and its hash chain, the read, verify and export-record functions, the real audit sink, every change and its audit entry in one transaction (the accepted invite included), export and verify over a write-once store, the refusal to export from a record that is ahead of the store, and the final-review wave.

| Package | State | Evidence |
|---|---|---|
| 6 Audit log | Done | Entries are written only by `audit.append` (migration 0009), in the caller's transaction; read, verify and export-record functions (0010); the core's sink writes to the database; export and verify run over a store port |
| 9 Content integrity | Done for the version row | Strict payload schema, canonical text and `cv1` hash (`packages/canonical`, `packages/shared`); the database refuses update, delete and truncate of a version and any insert whose hash or named brand and item disagree (0008) |

| Acceptance test | State | Evidence |
|---|---|---|
| 14 | Proven | Test vectors in both directions: `packages/canonical/test/vectors.test.ts`, `packages/db/test/content-vectors.test.ts`, `packages/canonical/test/hash-fields.test.ts` |
| 15, 16 | Proven | A version cannot be updated, deleted or truncated, and a wrong hash or a payload naming another brand or item is refused: `packages/db/test/content-integrity.test.ts` |
| 17 | Proven | Strict schema and normalisation: `packages/shared/test/content-payload.test.ts`, `packages/canonical/test/vectors.test.ts` |
| 35 | Proven | Concurrent appends leave no gap or duplicate, a rolled-back transaction leaves no gap, forging another brand's chain is refused, an altered and re-hashed entry, a cut chain and a removed chain are caught against the export: `packages/db/test/audit-log.test.ts`, `packages/db/test/audit-verify.test.ts`, `apps/core/test/audit-export-verify.test.ts` |
| 36 | Proven | An audit failure undoes the change it records, with the real function: `apps/core/test/audit-chain.test.ts`, `apps/core/test/db-audit.test.ts` |
| SEC-8, first half | Proven | No role holds a right on an audit table (catalog tests, including no `PUBLIC` execute on the audit functions) |

Not proven yet, and why:

- The daily export and verify jobs: they need the queue and worker (milestone 4). The functions they will call are written and tested.
- The real write-once store outside the server: owner items A4 and A5. A port and an in-memory store stand in.
- The severity 1 alert on a mismatch: alert delivery is package 11. `verify` takes an `onMismatch` callback; nothing is wired to it.
- The audit screen, and the logging of people's reads of the log (SEC-8, second half): the dashboard milestone.
- The approval-hash trigger and the content-version creation service: package 10.
- Retention of the log: owner item F2; the log has no delete at all.

## Findings

Decisions: the seven decisions in the plan ("Decisions proposed to the owner") were built as written: audit entries through `audit.append`; hash computed and re-checked in the database; the entry's fields (`outcome`, `subject`, `detail` replace `subject_kind`, `subject_id`, `before`, `after`); no-brand entries on the platform chain; the five body blocks; two zero-width characters allowed; single-line fields reject line breaks. The owner's acceptance is not recorded in the repository; it is to be confirmed in the pull request.

- Rulings (made while building, in plain language):
  1. (Task 7, controller) A failed audit write is not a failed attempt by the user: the change is undone and the request answers 500; a mail failure stays 502.
  2. (Task 7, controller, ruling R4) `auth.invite_accepted` was a plan gap (the accept ran outside a transaction, so its entry was written after the fact). It was fixed in the milestone, not deferred: redeeming the invite and its audit entry now share one transaction (5ef58ef).
  3. (Task 8, final review) The export refuses to run from a database record that is ahead of the store or the chain, because resuming from a forged record would stall silently (173c798).
  4. (final review) The hash's own text for `at` is exposed by `audit.at_text`, and the export uses it, so the exported time matches the hashed time to the microsecond.
  5. (final review) `audit.append` reads the clock after taking the chain lock, so `at` never goes backwards inside a chain.
  6. (final review) A withdrawn invite's `users.invite_withdrawn` entry is written in the same transaction as the delete; if it cannot be written the delete is rolled back.
  7. (final review) `audit.record_export` refuses a NULL hash; the verify function rejects a NULL hash in the export record.
- Deployment precondition new in this milestone: the service needs `AUDIT_DATABASE_URL`, the audit-writer role's login, in its environment (checked by the config and `.env.example` tests). The roles' production passwords come from the secrets store at deployment.
- Follow-ups, one line each:
  - Cancelling a pending invite: still not built.
  - The owner's all-brands list needs the owner-view role and an audit entry per call (dashboard milestone).
  - Real mail (package 11); the invite code rule for `brand_admin` (2c ruling 8) is still a decision for the owner.
  - A person's reading of the log is itself to be logged (dashboard milestone).
  - Closed by this milestone: the 2c follow-up "audit entries atomic only in the fail-closed direction"; the sink now takes the transaction client.
- Verification: two consecutive `npm ci && npm run verify` runs on the development server both passed: 63 test files and 427 tests passed, 1 skipped (the model check, which needs an API key), and the secret scan found no leaks. No test database was left behind (`mkt_t_%` count 0).

## Phase 1, milestone 4: Work engine

Finished: 2026-10-14 (built 2026-10-13). Branch `m4-work-engine`, base `eb4af53` (main), commits `d27070f` to the final commit of this milestone (`git log --oneline main..HEAD`): the plan; the queue package, its schema and what each role may do (with a test pinning the application role out of job data); the tables for runs, jobs, attempts, model calls, cost, exchange rates and model prices (migrations 0011 and 0012); one interface over the queue library (send, work, state, depth, dead letters, a watchdog), with a fix wave; the fairness test (a large backlog in one brand does not delay another); the attempt token, cost arithmetic and job creation in the business transaction; the worker starting an attempt and being checked by its token, with refusals recorded; registering and costing a model call; posting a result once; the worker process and the crash tests; the dead-letter list, requeue, cancel, the model-call sweep and the reconciliation of failed jobs (migration 0013); one final fix wave after the whole-branch review, and a test-only fix found by the verify runs. Each task had its own review and fix rounds before the next began.

| Package | State | Evidence |
|---|---|---|
| 7 Job queue | Done | One queue library behind `packages/queue` (`@mkt/queue`); four job classes (interactive, publishing, production, bulk) with their own retry, expiry and concurrency settings; jobs are created in the same transaction as the business change; dead-letter list, requeue and cancel; fairness between brands measured (test 29) |
| 8 Worker and model-call ledger | Done | A worker process claims jobs, asks the core to start an attempt, runs steps with checkpoints, and posts one result; every model request is registered before it is sent and costed in both currencies after; a killed worker is recovered without paying twice for a step that was checkpointed (tests 24 and 25) |

| Acceptance test | State | Evidence |
|---|---|---|
| 6 | Proven, narrower than its title | A wrong, expired or tampered attempt token, a token for another job or brand, and a call from an attempt that is no longer current are all refused and recorded: `apps/core/test/worker-attempts.test.ts`, `apps/core/test/attempt-token.test.ts`. The gate is the shared worker credential plus the queue showing the job `active`; the credential is the trust root (a stale worker with the credential can start a new attempt while the queue shows active). |
| 26 | Proven, narrower than its title | A second start supersedes the first attempt; the old attempt's token is then refused for checkpoint, model call and result: `apps/core/test/worker-attempts.test.ts`. Lease loss is simulated by a second start, not by waiting for a real heartbeat to lapse; real heartbeat loss is exercised by tests 24, 25 and 28. |
| 32 | Proven | Token fields, signature and expiry checks, and that the attempt token is not the worker credential: `apps/core/test/attempt-token.test.ts`, `apps/core/test/worker-attempts.test.ts` |
| 24 | Proven | A worker killed before the provider's reply is recovered by a second worker; step 1 sent once, step 2 sent twice (the killed request and its retry), step 3 once; the result applied once: `apps/worker/test/crash.test.ts` (about 17 s), ledger half in `apps/core/test/model-calls.test.ts` |
| 25 | Proven | A worker killed after the provider's reply but before the checkpoint: the step is sent twice, the second call is flagged `possible_duplicate`, three cost rows exist, the result is applied once: `apps/worker/test/crash.test.ts` (about 16 s), ledger half in `apps/core/test/model-calls.test.ts`. The model is a stand-in; the real provider is not called. |
| 27 | Proven | A result posted twice is applied once and the second answer matches the first; a result of the wrong type is refused; a held job's result is stored as held; concurrent posts are safe: `apps/core/test/job-results.test.ts` |
| 28 | Proven | A job that fails every attempt reaches the dead-letter list, is listed, requeued (the run is revived) and then succeeds; a lost dead-letter copy is found by reconciliation: `apps/worker/test/dead-letter.test.ts` (about 16 s, queue timing scaled by 0.1), `packages/queue/test/queue-dead.test.ts`, `apps/core/test/jobs-dead.test.ts` |
| 29 | Proven | Brand A has about 500 production jobs waiting; brand B's first job starts within 27 to 64 ms. Measured peaks: one worker process, brand A 3 at once (the production cap), brand B production 2 to 3 and interactive 2; two processes, brand A 2 at once. Brand A had ended 14 to 36 of its 500 jobs when brand B finished: `packages/queue/test/fairness.test.ts` |

Not proven yet, and why:

- Tests 30 and 31, and the kill switch's cancel-and-hold of waiting jobs: package 12. A held or cancelled job is `completed` in the queue, so release needs its own path (see follow-ups).
- Alerts for dead jobs, long-waiting jobs and unknown model calls: package 11 (alert delivery).
- The daily jobs and the signed n8n trigger, and the exchange-rate fetch: milestone 6. The worker runs the reconciliation sweep on a 5-minute timer until then (plan decision 8). A rate is entered through `app.record_fx_rate`.
- A real provider call: owner item A3 (the key) and the model price figures. Every test uses a stand-in model; the one real-model check in `stack-check` is skipped without a key.
- Not built at all: a read endpoint or screen for the reconciliation list (unknown and uncosted calls), a provider rate limiter shared between worker processes, a cancel endpoint for a live (not dead) job, watchdog alerts, and surfacing `stop_reason: max_tokens`.

## Findings

The ten decisions in the plan ("Decisions proposed to the owner") were built as written; the owner said "continue with the plan" on 2026-10-13 after the plan was presented with the ten decisions, which is recorded here as acceptance; any change is to be raised on the pull request.

- Rulings (made while building, in plain language, rulings first):
  1. (Task 5) `Stack.jobs` in the test support is nullable: it is null unless a test asks for the queue (`withQueue`), so tests that use it check for null first.
  2. (Task 9, controller) Before posting a result, the worker stops only for a cancel. If the job is held it still posts, and the core stores the result as held (spec 9.4: "If a result is posted anyway, the core stores it as held"). The work was paid for and is kept; the cost if this is wrong is that a held job's result sits in the database until released. Between steps and before each model call, a hold still stops the job.
  3. (Task 10) Dead-letter handling: handling the library's dead-letter copy completes it, so the dead-letter queue stays empty and the business tables are the list (plan decision 4). Because a copy can be lost, the worker's maintenance tick also reconciles: it asks the core which failed jobs are not yet marked dead (a definer function, migration 0013, newest first, 500 at a time) and reports them. Marking dead and requeueing both require the queue to show the job `failed`, so a redelivered copy after a requeue changes nothing. The dead-letter queues retry with their own settings.
  4. (Task 10) Cancelling a dead job needs the queue role to update a failed job to cancelled directly in the library's table (guarded to that one transition), because the library's cancel does not act on a failed job.
  5. (Task 6) A started attempt takes a row lock on the job's input row; every write that checks the current attempt takes the lock first, so a superseded attempt cannot write after a new one starts. Lock order everywhere: job, then run, then whatever a result handler writes (Task 8, with a deterministic test).
  6. (Task 7) The 1 MB body limit applies only to the checkpoint path, and only after the worker credential is checked; an unauthenticated caller cannot make the server parse more than the global limit.
  7. (Task 2) The definer role holds select and insert on `fx_rate` (the plan said insert only), because `record_fx_rate` reads the row it conflicts with.
  8. (Task 3) The queue's notification poll is set to each class's own interval (2 s), because the library does not notify when a retry delay ends; with 30 s every retry ran 14 to 24 s late.
  9. (Task 9) Worker model requests set `maxRetries: 0` and a timeout of 240 s; only a definite refusal (a 4xx other than 408) marks a call `failed`; a timeout, connection error or 5xx leaves it `started` (so it is counted as a possible duplicate on retry).
  10. (final review) One fix wave, not several: seven findings fixed together (see below), then a scoped re-review.
  11. (final review, parked) A run with more than one job can end up `failed` for good: job 1 dead, job 2 retried, job 1 cancelled, job 2 finishes; `postResult` only moves a `created` or `running` run, and a cancelled job keeps `finished_at` null so a revived run cannot reach `succeeded`. No production code in this milestone creates a run with more than one job (agents arrive in milestone 6), so it is recorded and not fixed. Fix idea: when a job finishes or is cancelled, finalise the run if no job is dead and none is unfinished and not cancelled.
- Findings fixed in review (Important, one line each):
  - Task 1: the refusal tests covered only the parent table, not the job partition and column boundary; added.
  - Task 3: one job per fetch (batch size 1); the watchdog did not see retries or deferred starts and was untested; the notification path was unproven.
  - Task 4: the fairness test needed a lower bound on brand A's peak, a ready handshake before the timing, isolation between runs, and a cap brand B's production could not exceed.
  - Task 6: the current-attempt check took no lock and raced with a superseding start; the cookie test sent no cookie.
  - Task 7: the 1 MB parser ran before authentication on a broad mount; an `unknown` call was not counted as a possible duplicate; the model was not validated against the registered row; the unauthenticated-body test was too weak.
  - Task 8: write skew on the run state across concurrent jobs (lock the run row); run state was overwritten without a guard; the run lock was taken after the handler (deadlock with handlers that write run-linked rows); a concurrent test that could never fail.
  - Task 9: a cancel seen at post time was retried to the dead letter; a paid checkpoint was not retried; SDK retries and the failed-versus-unknown marking; the SIGTERM handler was not graceful; a hold at post time discarded a finished result; replies from the core were not validated.
  - Task 10: a requeued job's rolled-back run stayed `failed` (the next start now revives it); a lost dead-letter copy never marked the job dead (explicit retry plus reconciliation); marking dead trusted a redelivered copy (guarded by queue state); the reconciliation window was oldest-first and re-reported marked jobs (newest first, unmarked only).
  - Final review: a run revived while a sibling job was dead (I1); queue library errors were swallowed (`onError` now reaches the log, I2); the 0013 down migration did not revoke the definer's select; the worker's variables were missing from `.env.example`; the model request timeout was longer than the class expiry (now 240 s); `cancelJob` refused a job the queue already showed cancelled (a half-done cancel can now finish); `send` ignored a null return from the library.
- Deployment preconditions new in this milestone:
  - Order: migrations 0011 to 0013, then `installQueue` as the database owner, then the core, then the worker. The core needs `QUEUE_DATABASE_URL`, `WORKER_SECRET` and `ATTEMPT_TOKEN_SECRET`; the worker needs `CORE_URL`, `WORKER_SECRET`, `QUEUE_DATABASE_URL` and `ANTHROPIC_API_KEY`.
  - `installQueue` creates only queues that are missing. An existing deployment needs `updateQueue` for the dead-letter retry settings (they are not applied to queues that exist), and `installQueue` must be run again after a pg-boss upgrade (the grants are applied once). There is no deploy entry point for it yet (package 16).
  - Model prices (`app.model_price`) and the first exchange rate (`app.record_fx_rate`) must be entered before the first real call; until then every call is `succeeded` and uncosted, and listed for reconciliation.
  - The proxy must pass `Authorization` on `/api/v1/worker/` and allow a 1 MB request body on the checkpoint route.
  - The process manager's stop grace period must exceed 30 s, so a worker finishes its step before it is killed.
- Follow-ups, one line each:
  - Package 12, release of held and cancelled jobs: a held or cancelled job is `completed` in the queue, and the library's `send` with that id is a silent no-op, as is `retry` of a completed job (observed). Release needs its own path: a separate queue id column, a direct reset by the queue role, or not completing held jobs. The cancelled job's attempt stays `active`, and `held_result` is last write wins and is not cleared on cancel or reclaim; the release step must consume it.
  - Verify whether the library's `retry()` resets `retry_count`: a requeued job that fails once may go straight back to the dead letter.
  - A `succeeded` attempt can still act on the control, register and checkpoint routes (`allowSucceeded` is meant only for posting a result).
  - Results are capped at 100 kB (checkpoints 1 MB); `saved_steps` is unbounded and rewritten in full on each checkpoint.
  - `postResult` is not retried by the worker on a transient error; a job that finishes its work and then meets one 5xx is retried and finds its checkpoints.
  - The worker's `deadJobs` client call is unused.
  - Class expiry also caps the token's lifetime; long model calls need a longer class (package 13).
  - A dead-job reconciliation window can starve if 500 or more newer failed jobs are already marked; the maintenance interval makes this unlikely.
  - The foreign keys of a model call do not tie its run, job and attempt together within a brand; cost columns have no both-or-neither check; the definer's update right on `model_call` is not column-limited.
  - Worker error classes of the real SDK are untested (only the stand-in model); the production entry imports a test stand-in model until the real adapter is wired in package 13.
  - Test-timing risks: the crash, dead-letter and fairness tests depend on timers and child processes (the three together are about 50 s; the fairness assertions on two processes are the least deterministic), and the worst case of the fairness test exceeds the 120 s test timeout on a failing run. The combined `apps/core apps/worker packages/queue packages/db` run takes about six minutes.
  - Deferred minors from the task reviews are in the working ledger of this milestone (`.superpowers/sdd/2026-10-13-m4-work-engine/progress.md`, not committed): `divideRound` accepts negatives; no deploy rejection of `CHANGE_ME` secrets in production; expired and not-yet-valid token refusals are recorded with no brand although the signature was verified.
- Verification: four consecutive `npm ci && npm run verify` runs on the development server were made. The first ended with exit 1: all 596 tests passed, but one unhandled connection error (`57P01`) was raised by the test "hands an error from its connections to onError" in `packages/queue/test/queue.test.ts`, which Vitest counts as a failure. Cause: the test terminated the library's LISTEN connection as `stop()` ran, and the library removes that connection's error listener before ending it. The test now terminates only the pooled connections (a test-only change). The three later runs (one before and two after the change) each passed every step: 85 test files and 596 tests passed, 1 skipped (the model check, which needs an API key), `check:pins`, lint, format check, typecheck and `npm run secrets` (no leaks; note that the server's copy of the repository has no `.git` synced, so the secret scan on the server covers its older history; the branch itself was scanned from the laptop's `git log main..HEAD -p`: no server address, no key, secret or password other than placeholders). Two test databases left over from earlier runs of 2026-10-13 (`mkt_t_%`) were dropped; after the runs the count is 0 and no worker or test process is left running on the server.
- Pull request: not opened when this is written.
