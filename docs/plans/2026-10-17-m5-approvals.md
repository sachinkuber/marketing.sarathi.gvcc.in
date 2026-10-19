# Milestone 5 — Approvals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A content version is approved against its hash; reminders and escalation run on a test clock and never approve anything; the kill switch holds and releases work; notifications and alerts have delivery state.

**Architecture:** One migration (0014) adds the missing tables and two database guards (the approval-hash trigger and the state-transition trigger). Core gets four services: content versions, approvals, notifications/alerts, kill switch. Each writes its audit entry in the same transaction as the change. The worker's existing maintenance tick drives the reminder check through a core endpoint, with an injectable clock. Real mail and the second alert channel sit behind ports; this milestone ships test doubles for them.

**Tech Stack:** As pinned in spec section 3 (Node, TypeScript, Express 5, zod, Postgres with forced RLS, pg-boss via `packages/queue`, vitest). All commands run on the dev server through `/opt/mkt-dev/run.sh`.

**Spec:** `docs/specs/2026-10-04-phase-1-foundation.md` sections 9.4, 10, 12, 13, 16, 17. Schema: `docs/database/2026-10-04-database-schema.md` (sections 8, 11.2). Progress: `docs/progress.md`.

## Scope

Work packages 10, 11, 12, 12a. Acceptance tests 18, 19, 20, 21, 22 (API half), 23, 30, 31, and 38 (code path only).

**Not in this milestone:**
- Dashboard screens, including the pop-up and banner as screens: package 15. Here the data and endpoints they read are built and tested (test 22 is proven at API level only).
- The trivial agent, the placeholder-check job and the call that creates version 1 from a result: package 13 (milestone 6). Package 10 provides `createVersion(client, input)` for that handler to call.
- n8n triggers: package 14.
- A real mail transport and the second alert channel: owner items (sender account; A11). Test 38 is not proven here.

## Global Constraints

- Commands run only on the dev server via `/opt/mkt-dev/run.sh`; the server address never enters the repo, commits, PRs or reports.
- Every route is declared through `RouteTable.add` with an access kind and a summary. Brand routes live under `/brands/:brandId`.
- All brand data is read and written inside `withBrand`. Audit entries are written with the transaction's client (`audit.record(entry, client)`), action names `area.verb`.
- `content_version` is immutable; approvals and invalidations are insert-only. No code path updates them.
- Silence is never approval: no code path created by this milestone may insert an `approval`, change a version to `approved`, or create an `outbox_action` except the approve route.
- Migrations: `0014_*.sql` with `-- Up Migration` / `-- Down Migration`; definer functions follow the 0011/0013 pattern (`security definer`, `set search_path = pg_catalog, app`, owner `mkt_definer`, revoke from public, grant to a named role).
- No secret, address or recipient in logs; log error name and code only.
- Test files live next to the area they test (`apps/core/test/...`, `packages/db/test/...`). The whole suite and lint/format/typecheck pass on the dev server before the PR.

## Decisions the plan makes (owner may overrule)

1. **Approval-hash trigger in the database** (schema doc 11.2): inserting an `approval` whose `version_hash` or `hash_scheme` differs from its `content_version` is refused.
2. **State transitions enforced by a trigger** on `content_version_state` (allowed-transition table), as well as by service code.
3. **Approval settings use the existing `edit_profile` permission** (platform owner and brand admin hold it). No new permission key, so the PRD 16.1 comparison test is untouched.
4. **Mail and the second channel are ports** (`Mailer`, new `AlertChannel`) with an in-memory double for tests. No real transport is chosen; the nodemailer advisory decision stays with the owner.
5. **Kill switch scopes.** Brand and agent scopes hold jobs now. Channel scope is stored, shown and audited but holds nothing, because no job has a channel in phase 1.
6. **Hold and release path.** Setting the switch marks the brand's unfinished jobs held in the same transaction. A held job that the queue has already completed is re-enqueued on release under a new queue id (the library ignores a send or retry of a completed id). The implementer reads `packages/queue/src/queue.ts` first and picks the smallest change that meets the contract in Task 8; the choice is recorded as a ruling.
7. **Step-up for the kill switch** is the existing per-request TOTP check (`verifySecondFactorCode`), the same strength as a role change.
8. **Shadow mode** is set by the platform owner only, with audit.
9. **Reminder host.** The worker's maintenance tick calls `POST /api/v1/worker/approvals/tick`. The check is idempotent and driven by stored timestamps, so the tick period does not change results. The clock is injected (`Clock` port); production uses the system clock.
10. **Escalation recipients.** Approver → brand admins → platform owners. A recipient is a user; the address is resolved when the mail is sent. Platform owner who is already the approver: marked overdue only (spec 10.6).
11. **Not built:** the 90-day notification retention job (follow-up).
12. **`app.alert` has a nullable `brand_id`**, so it gets explicit policies (brand members read their brand's alerts; platform-level alerts are read through an owner-only definer function) instead of the standard loop.

## Review Focus

1. A stale screen approves after an edit — expected: refused (test 18), and the old approval does not carry to the new version.
2. Two people approve the same version at once — expected: one approval, the other told it is already decided; one outbox action.
3. A reminder tick runs twice, or ten ticks run after a long outage — expected: no duplicate reminders; at most the due reminder is sent, never a burst.
4. A version is edited while its request is open — expected: the old request closes, the new version opens its own, the banner count does not double.
5. The kill switch is set while a job is between "claimed" and "posted", and released twice — expected: the result is held (test 31); the second release changes nothing.

## File structure

- `packages/db/migrations/0014_approvals_alerts_hold.sql` — new tables, triggers, definer functions.
- `packages/db/test/approvals-schema.test.ts` — schema guards.
- `apps/core/src/content/` — `versions.ts` (createVersion, edit, list/get), `states.ts` (transition table shared by service and test).
- `apps/core/src/approvals/` — `service.ts` (approve/reject/comment), `requests.ts` (open/close, reminders, escalation), `settings.ts`.
- `apps/core/src/notify/` — `notifications.ts`, `alerts.ts`, `ports.ts` additions (`AlertChannel`, `Clock`), `doubles.ts` (test doubles, exported only to tests).
- `apps/core/src/killswitch/` — `service.ts`, `release.ts`.
- `apps/core/src/routes/` — `content.ts`, `approvals.ts`, `approval-settings.ts`, `alerts.ts`, `killswitch.ts`, `shadow.ts`, plus worker route `approvals-tick` in `routes/jobs.ts` neighbours.
- `apps/worker/src/maintenance.ts` — add the approvals tick call.
- Tests under `apps/core/test/` named after the module.

---

### Task 1: Migration 0014 and schema tests

**Files:** Create `packages/db/migrations/0014_approvals_alerts_hold.sql`, `packages/db/test/approvals-schema.test.ts`.

**Interfaces:**
- Produces: tables `app.notification`, `app.alert`; column `app.job_control.queue_id uuid` (null until a release re-enqueues); trigger `approval_hash_matches` on `app.approval`; trigger `version_state_transition` on `app.content_version_state`; unique partial index so a version has at most one open `approval_request`; check that `outbox_action.kind` is in (`none`) for now; definer functions `app.platform_alerts()` (owner-only read) and `app.hold_brand_jobs(brand uuid, agent text, hold boolean)` returning the job ids it changed.

- [ ] **Step 1: Write failing schema tests.** Cases: (a) approval with a wrong `version_hash` is refused; with a wrong `hash_scheme` refused; with the right pair accepted. (b) Every allowed transition is accepted and every other pair (all 12×12 minus allowed) is refused. (c) A second open `approval_request` for the same version is refused. (d) `notification` and `alert` rows are invisible across brands; a platform alert (`brand_id` null) is invisible to `mkt_app` and visible through `platform_alerts()` only to the owner. (e) `outbox_action.kind = 'x'` refused. (f) Down migration then up migration again works.
- [ ] **Step 2: Run to confirm they fail** (`/opt/mkt-dev/run.sh` test run of the file): expect missing relation / function errors.
- [ ] **Step 3: Write the migration.** Allowed transitions (from → to): draft→in_checks, in_checks→awaiting_approval, in_checks→draft, awaiting_approval→approved, awaiting_approval→rejected, awaiting_approval→superseded, awaiting_approval→invalidated, approved→superseded, approved→invalidated, rejected→superseded, draft→superseded, in_checks→superseded. The implementer checks these against the 12 `version_state` values and architecture 8.2 and corrects the list against the spec, recording any change as a ruling. `notification` columns per schema doc 8.1, `alert` per 8.2; RLS forced; grants: `mkt_app` insert/select/update on notification (state and counters only through a definer function if the doc says so), select/insert/update on alert.
- [ ] **Step 4: Run the schema tests and the full db package tests.** Expected: pass.
- [ ] **Step 5: Commit** `feat(db): approvals guards, notification and alert tables, hold support (0014)`.

### Task 2: Content version service and read routes

**Files:** Create `apps/core/src/content/states.ts`, `versions.ts`, `apps/core/src/routes/content.ts`, tests `apps/core/test/content-versions.test.ts`. Modify `api.ts` to register the routes.

**Interfaces:**
- Consumes: `prepareVersion` from `@mkt/canonical`; `withBrand`; migration 0014.
- Produces:
  - `createVersion(client, deps, input: {brandId, contentItemId, payload, createdBy: {kind, userId?, runId?}}): Promise<{versionId, number, hash}>` — locks the item row, takes the next number, prepares the payload, inserts `content_version` and `content_version_state` (draft), supersedes the previous version if it is open (state change + audit + closes its approval request), updates `content_item.current_version_id`.
  - `moveState(client, deps, versionId, to, actor)` — checks `states.ts`, writes `content_version_state_change`, audits `content.state_changed`.
  - Routes (permission `view_content` for reads, `approve_content` for edit): `GET /brands/:brandId/content` (inbox list: filter by state, overdue), `GET /brands/:brandId/content/:itemId` (versions and states), `POST /brands/:brandId/content/:itemId/versions` (edit; body is the payload without ids).

- [ ] **Step 1: Failing tests:** creating twice gives numbers 1 and 2 and the first is `superseded`; a payload with an invisible character is rejected with `PayloadRejected` path and nothing is stored; a disallowed transition throws; brand B's session gets 404 for brand A's item (isolation); `moveState` audits.
- [ ] **Step 2: Run, expect failures.**
- [ ] **Step 3: Implement.** `states.ts` exports the same transition table the migration uses; a test asserts the table equals the database's (query `version_state_transition` table or probe every pair).
- [ ] **Step 4: Run tests, then lint/typecheck.**
- [ ] **Step 5: Commit** `feat(core): content version service and read routes`.

### Task 3: Approvals (approve, reject, comment) — tests 18 and 19

**Files:** Create `apps/core/src/approvals/service.ts`, `apps/core/src/routes/approvals.ts`, tests `apps/core/test/approvals.test.ts`.

**Interfaces:**
- Produces: `approve(pool, deps, {brandId, versionId, hash, scheme, actor})`, `reject(..., {reason})`, `comment(...)`. Routes: `POST /brands/:brandId/content/:itemId/versions/:versionId/approve` (body `{hash, hash_scheme}`), `/reject` (`{reason}`), `/comments`. All `permission: approve_content`.
- `approve` in one `withBrand` transaction: lock the version state row `for update`; require state `awaiting_approval`; compare `hash` with stored hash (mismatch → 409 `stale_hash`, audited as failure); insert `approval`; move state to `approved`; insert `outbox_action` (`kind none`, state confirmed, idempotency key `approval:<approvalId>`); close the open request; audit `approval.approved`.

- [ ] **Step 1: Failing tests.** (18) Approving with the old hash after an edit → 409, no approval row; the old version is `superseded`, its approval (if any) has no effect on version 2. (19) Force a failure after the approval insert (a thrown error injected between steps, via a deps hook used by tests only) → no approval, no state change, no outbox row. Two concurrent approves → exactly one approval row and one outbox row, the loser gets 409 `already_decided`. Approver without `approve_content` (viewer) → 403. Reject records reason, moves to `rejected`, audits.
- [ ] **Step 2: Run, expect failures.** **Step 3: Implement.** **Step 4: Run tests.**
- [ ] **Step 5: Commit** `feat(core): approve, reject and comment against the version hash`.

### Task 4: Notifications and alerts with delivery state — test 38 code path

**Files:** Create `apps/core/src/notify/ports.ts`, `notifications.ts`, `alerts.ts`, `doubles.ts`, `apps/core/src/routes/alerts.ts`, tests `apps/core/test/notify.test.ts`.

**Interfaces:**
- Produces:
  - `AlertChannel` port: `send({subject, text}): Promise<{providerId: string}>`; `Clock` port: `now(): Date`.
  - `enqueueNotification(client, {userId, kind, subject: {kind, id}})` — inserts state `pending`.
  - `deliverPending(pool, deps, limit)` — for each pending/failed-under-limit notification: resolve the user's address, call `Mailer.send`, set `sent` plus provider id on success; on failure increment attempts, set `failed` after 5 attempts and raise a severity 2 alert (`notification_failed`). Logs error name only.
  - `raiseAlert(pool, deps, {brandId|null, severity, kind, detail})` — inserts the alert, sends by email to platform owners **and** through `AlertChannel`; the alert is `delivered` only when both calls return a provider id; otherwise stays `undelivered` and is retried by `deliverPending`'s sibling `retryAlerts`.
  - Routes: `GET /brands/:brandId/alerts` (permission `view_content`), `POST /brands/:brandId/alerts/:alertId/ack` (`approve_content`, audited), `GET /alerts` and `POST /alerts/:alertId/ack` (platform owner, platform-level alerts).
  - Wiring: audit-verify `onMismatch` → severity 1 alert; dead-letter and watchdog findings → alerts (wire where the M4 reads exist: `deadLetters`, `watchdog`, `unknownCalls`).

- [ ] **Step 1: Failing tests with the in-memory doubles:** success records provider id; two failures then success counts attempts; five failures → `failed` and one severity 2 alert; an alert whose channel call throws stays undelivered and is retried; alert delivered only with both provider ids; an ack by a viewer is 403; a platform alert is invisible to a brand route.
- [ ] **Step 2–4:** run, implement, run. **Step 5: Commit** `feat(core): notification and alert delivery with a second channel port`.
- Test 38 (real inbox, second channel, provider confirmation) is **not proven**: it needs a real transport and owner item A11. The progress record says so.

### Task 5: Approval requests, reminders, escalation, settings — tests 20, 21, 23

**Files:** Create `apps/core/src/approvals/requests.ts`, `settings.ts`, `apps/core/src/routes/approval-settings.ts`, a worker route `POST /worker/approvals/tick`, tests `apps/core/test/approval-requests.test.ts`.

**Interfaces:**
- Consumes: `Clock`, `enqueueNotification`, membership lookup for recipients.
- Produces: `openRequest(client, versionId)` (called by `moveState` when entering `awaiting_approval`); `closeRequest(client, versionId, reason)` (on decision or supersede); `tick(pool, deps)` — for every open request, using the brand's settings (`first_reminder_after`, `reminder_gap`, `reminder_count`): send reminder n when `now >= opened_at + first + (n-1)*gap` and `reminders_sent < count`, at most one reminder per request per tick; when `reminders_sent == count` and `now >= last_reminder_at + gap` and not overdue → set `overdue`, escalate to brand admins then, on a later gap, platform owners (record `escalated_to`, notify them), audit `approval.overdue` / `approval.escalated`. Routes: `GET/PATCH /brands/:brandId/approval-settings` (permission `edit_profile`; values validated: count 1–5, durations positive; audited; effective from the next tick).

- [ ] **Step 1: Failing tests with a controlled clock.** (20) Defaults: reminders exactly at 24, 48, 72 h and none after; at 96 h overdue + escalated to brand admins. (21) Advance the clock 30 days: no `approval` row, no `outbox_action`, version still `awaiting_approval`. (23) Change count 3→2 while a request is open: the third reminder never goes; change timing: next reminder moves; a brand approver gets 403; owner and brand admin succeed. Idempotence: tick ten times at the same instant sends nothing extra; after a 10-day outage one tick sends one reminder, not a burst. Platform owner as sole approver: overdue only, no escalation.
- [ ] **Step 2–4:** run, implement, run. **Step 5: Commit** `feat(core): approval requests, reminders, escalation and settings`.

### Task 6: Overdue pop-up and banner data — test 22 (API half)

**Files:** Create `apps/core/src/routes/overdue.ts`, tests `apps/core/test/overdue.test.ts`.

**Interfaces:** `GET /brands/:brandId/approvals/overdue` (permission `approve_content`) → `{items, popup: {due: boolean}}`; `POST /brands/:brandId/approvals/overdue/ack` body `{choice: 'review_now' | 'later'}` recorded in `popup_ack`. The banner count is the number of overdue open requests and does not change on "later". `popup.due` is true when the user has an overdue item they have not been shown since it became overdue, or since their latest sign-in with any overdue item remaining.

- [ ] **Step 1: Failing tests:** appears when an item becomes overdue; "later" recorded and banner count unchanged; reappears at the next sign-in (simulate a new session id) while any remain; no longer reported once the item is decided; a viewer gets 403; brand B sees nothing.
- [ ] **Step 2–4:** run, implement, run. **Step 5: Commit** `feat(core): overdue approvals read and pop-up acknowledgement`.
- The pop-up window and banner themselves are package 15; progress.md records test 22 as proven at API level only.

### Task 7: Kill switch and shadow mode

**Files:** Create `apps/core/src/killswitch/service.ts`, `apps/core/src/routes/killswitch.ts`, `apps/core/src/routes/shadow.ts`, tests `apps/core/test/killswitch.test.ts`.

**Interfaces:** `setSwitch(pool, deps, {brandId, scope, target, actor})`, `releaseSwitch(...)`; routes `POST /brands/:brandId/kill-switch` (`{scope, target?, code}`), `DELETE`-style release as `POST /brands/:brandId/kill-switch/release` (`{scope, target?, code}`), `GET /brands/:brandId/kill-switch`; all `permission: use_kill_switch`, TOTP checked with `verifySecondFactorCode` before the service call. Setting calls `app.hold_brand_jobs(brand, agent_or_null, true)`; the unique partial index keeps one active switch per scope/target (a second set is a no-op returning the existing row). Shadow: `PATCH /shadow-mode` per brand, `platform_owner` only, `{shadow_mode: boolean}`, audited.

- [ ] **Step 1: Failing tests:** wrong or missing code → refused and audited; set holds the brand's waiting jobs (`job_control.held`) and no model call is registered for them; agent-scope hold affects only that agent's runs; channel scope is stored and holds nothing; a second set is idempotent; shadow set by a brand admin → 403.
- [ ] **Step 2–4:** run, implement, run. **Step 5: Commit** `feat(core): kill switch set and release, shadow flag`.

### Task 8: Release path and held results — tests 30 and 31

**Files:** Create `apps/core/src/killswitch/release.ts`; modify `packages/queue/src/queue.ts` only if the contract below needs it; tests `apps/core/test/killswitch-jobs.test.ts` (integration with the queue and a worker process as in M4 tests).

**Contract:** (a) Held jobs make no model call and post nothing that creates a version, job or notification. (b) Release makes every job that was held and never finished run again exactly once, whether the queue still had it waiting or had already completed it. (c) A `held_result` stored while the switch was on is consumed on release: applied once through the same result handler path as a normal post, then cleared; a stale one from a cancelled/reclaimed attempt is discarded. (d) Releasing twice changes nothing the second time. (e) Dead-letter requeue and cancel keep working.

- [ ] **Step 1: Read `packages/queue/src/queue.ts` and the progress.md follow-up (line ~278)**, record the chosen mechanism as a ruling. Verify first, by a small test against the pinned library, whether `retry()` resets `retry_count`.
- [ ] **Step 2: Failing tests.** (30) Switch set while 5 jobs wait → all held, zero model calls (assert with the stand-in model's call count); release → all 5 run once. (31) Switch set while a job runs → its result is stored held; no content version, no further job and no notification exists afterwards; on release the result is applied once. Include a job whose queue row was already completed when released.
- [ ] **Step 3–4:** implement, run these and the M4 queue/worker tests (fairness test 29 included) to show nothing regressed.
- [ ] **Step 5: Commit** `feat(core): release held jobs and held results`.

### Task 9: Worker tick wiring

**Files:** Modify `apps/worker/src/maintenance.ts`, its test.

- [ ] **Step 1: Failing test:** one maintenance tick calls `POST /worker/approvals/tick` and a failure of that call is logged (error name only) without stopping the other duties.
- [ ] **Step 2–4:** implement; run worker tests. **Step 5: Commit** `feat(worker): drive the approvals tick from the maintenance timer`.

### Task 10: Record, verify, merge

- [ ] Update `docs/progress.md` with a "Phase 1, milestone 5" section: what is proven (18, 19, 20, 21, 23, 30, 31; 22 at API level), what is not (38; the screens), rulings, deploy notes (migration 0014; no new secret; ports need adapters before deployment), follow-ups (retention job, real mail transport, A11 channel, nodemailer advisory).
- [ ] Update the schema doc (sections 8, 11.2, 12) for 0014; try to regenerate the `.docx` copies (note if `mmdc` is still missing).
- [ ] Verify twice on the dev server: lint, format, typecheck, the full test suite, secret scan; confirm no leftover test databases.
- [ ] Open the PR, wait for green CI, run the whole-branch review, apply one fix wave, merge under the standing instruction.

## Acceptance for this milestone

18, 19, 20, 21, 23, 30, 31 proven by passing tests; 22 proven at API level; 38 explicitly not proven; M4 tests (24–29, 32) still pass.
