# Phase 1 — Foundation: Technical Spec

| Document control | |
|---|---|
| Version | 5 |
| Status | **Approved** |
| Approved by | Sachin Tripathi, platform owner, on 2026-10-04 ("Phase 1 spec version 5 approved"). Replaces version 4. The change was approved as described in the queue trial findings, section 5. |
| Date | 2026-10-04 |
| Owner | Sachin Tripathi (platform owner) |
| Prepared by | Claude Code |
| Canonical source | `docs/specs/2026-10-04-phase-1-foundation.md`. The Word file is generated from it. |
| Implements | Architecture version 2, section 19, phase 1. Master PRD version 3. App flow version 2. Tech stack version 1. All approved on 2026-10-04. |
| Correction after approval | 2026-10-04: section 3 now copies ESLint 10.10.0 from Tech stack version 2, which the owner approved. No other change. |
| Changes in version 5 | The per-brand job limit is enforced per worker process, not globally, following the queue trial (`docs/trials/2026-10-04-queue-trial.md`). Sections 3, 9.2, 9.3 and 19 only. |
| Changes in version 4 | Stack replaced by the approved Tech stack version 1 (section 3). Phase 1 items from the approved App flow version 2 added: approval reminders and escalation, approval settings, the overdue pop-up and banner, the alerts screen and the Home layout (sections 2, 5, 8, 10.6, 15). Four acceptance tests and one work package added. |
| Changes in version 3 | Queue design made consistent: an opaque scheduling key per brand, the queue library's own heartbeats and group concurrency, and low-latency dispatch. Job tokens bound to one attempt. Honest guarantee about repeated model calls, with a model-call ledger. Four acceptance tests added or reworded. |
| Changes in version 2 | Exact content-hash rules; immutable payload separated from lifecycle state; pinned stack versions; sign-in schema as a controlled migration; job inputs moved out of the queue; expanded acceptance tests with measurable load criteria; corrected work packages. |

Requirement IDs in brackets refer to the PRD. "Architecture 7" means section 7 of the architecture document.

## 1. Goal

Build the base every later phase stands on, and prove it with one trivial agent running end to end. Nothing in this phase talks to a social platform, and nothing is published.

**Phase 1 is complete when PRD gate 0 passes:** tenant isolation is tested, the audit log works, the kill switch is tested, and a backup has been restored successfully.

## 2. Scope

| In phase 1 | Not in phase 1 |
|---|---|
| Repository, build and test setup, pinned versions | Any real agency agent (phase 2 onward) |
| Database, roles and row-level security | Connection service, platform tokens, publishing (phase 3) |
| Sign-in with a second factor; roles and permissions | Key management for platform tokens (phase 3) |
| Core service API | Leads, pipeline, platform webhooks (phase 4) |
| Dashboard shell, approval inbox, agents, jobs, audit and settings screens | Reports and attribution (phase 5) |
| Content versions with an immutable, hashed payload; approvals bound to the hash | The six content checks (phase 3); phase 1 has one placeholder check |
| Job queue with the rules in architecture 7 | Evaluation harness and fetch service (phase 2) |
| Worker, attempt tokens, model-call and cost ledgers | Passkeys (later; see section 7) |
| Audit log with hash chain, export and verification | Self-serve sign-up, billing (P2) |
| Kill switch and shadow-mode flags | |
| Notification delivery by email | |
| Approval reminders, escalation and approval settings | Bulk approval and calendar approval by period (phase 3) |
| Overdue pop-up and banner; alerts screen; Home with results and progress blocks | |
| One n8n workflow proving signed trigger calls | |
| One trivial agent, end to end | |
| Deployment to the shared server, backups, restore test, monitoring | |

Aztek is created as the first brand. A second test brand with its own rows is created so isolation is tested against real data.

## 3. Pinned stack

The stack is set by the approved **Tech stack version 2** (`docs/tech-stack/2026-10-04-tech-stack.md`), which gives the reason for each choice. Its rule: the most stable, widely used option for each job, a major version about a year old or more, and no release younger than 30 days. The versions below are copied from it. The first work package (section 18, package 0) confirms they work together before other work starts.

| Component | Selection | Version |
|---|---|---|
| Runtime | Node.js, long-term-support line 24 | 24.20.0 |
| Package manager | npm, as shipped with the runtime | 11.19.0 |
| Language | TypeScript, strict mode | 5.9.3 |
| Database | PostgreSQL | 17.11 |
| Database driver | pg | 8.23.0 |
| Schema changes | node-pg-migrate, running plain SQL files | 8.0.4 |
| Queries | Kysely | 0.29.5 |
| Dashboard | Next.js with React | 16.3.4 with 19.2.8 |
| Styling and forms | Tailwind CSS; React Hook Form | 4.3.3; 7.87.0 |
| Core HTTP framework | Express, with helmet | 5.2.1; 8.3.0 |
| Schema validation | Zod, strict objects | 4.5.4 |
| Sign-in | Better Auth, with its two-factor plugin | 1.7.2 |
| Job queue | pg-boss, behind our own queue interface | 12.30.0 |
| Model SDK | Anthropic TypeScript SDK; model `claude-opus-5-5` | 0.124.0 |
| Unit and integration tests | Vitest, against a real Postgres of the pinned version | 4.1.11 |
| Browser tests | Playwright | 1.63.0 |
| Code checks and formatting | ESLint; Prettier | 10.10.0; 3.9.6 |
| Logger | pino with pino-http, with a redaction list | 10.3.1; 11.0.0 |
| Sending email | Nodemailer | 9.1.1 |
| Error tracker | Sentry Node SDK; personal data scrubbed before sending | 10.73.0 |
| Containers | Docker with the Compose plugin | Recorded at server inspection |
| Reverse proxy | The proxy already on the server; nginx if there is none | Recorded at server inspection |

**Rules that make the build reproducible**

- Exact versions in `package.json`, no ranges. The lockfile is committed, and installs use it unchanged.
- The Node version is fixed in `.nvmrc` and in `engines`; the build fails on any other.
- Container images are referenced by digest, not by tag.
- The Postgres image used in tests is the same digest as production.

**Sign-in schema as a controlled migration**

- The sign-in library's tables live in their own database schema, `auth`.
- Its SQL is produced once with the library's `generate` command, reviewed, and committed as a numbered migration like any other.
- The library's `migrate` command is never run, and the application's database role has no right to create or alter tables, so the schema cannot change at run time.
- A library upgrade that needs a schema change repeats the same steps: generate, review the difference, commit as a new migration.

**Findings from checking the libraries**

- **Passkeys.** The sign-in library enforces the second factor on password sign-in but not on passkey sign-in by default. Phase 1 ships password plus authenticator-app code only. Passkeys are added later with the extra enforcement written and tested. This narrows architecture decision 006 for phase 1.
- **Queue: correction to version 2 of this spec.** Version 2 said the queue library has no worker heartbeat and no per-brand control. That was wrong. Version 12 provides automatic worker heartbeats, concurrency limits per job group, and dispatch by database notification. Phase 1 uses these and writes no heartbeat or fairness code of its own (section 9). A trial on the pinned 12.30.0 confirmed heartbeats, transactional send, dead letters and notification dispatch. It also showed that the global group limit is not strict, which is why section 9.2 uses the per-process limit.

## 4. Repository layout

| Path | Contents |
|---|---|
| `apps/dashboard` | The web app |
| `apps/core` | The core service |
| `apps/worker` | Job runners and the trivial agent |
| `packages/db` | SQL migrations, role definitions, typed queries, the `withBrand` helper |
| `packages/shared` | Schemas shared by services: job inputs, results, the content payload |
| `packages/canonical` | Canonical encoding and hashing of content payloads, with its test vectors |
| `packages/queue` | The queue interface and its pg-boss implementation |
| `agents/` | Agent definitions, one folder per agent, versioned |
| `infra/` | Compose file, proxy config, backup and restore scripts |
| `n8n/` | Exported copies of the product's n8n workflows |
| `docs/`, `tools/` | As today |

## 5. Data model

**Database schemas:** `app` (business tables), `auth` (sign-in library), `pgboss` (queue library), `audit` (audit log).

**Rules for every brand-scoped table**

- It carries `brand_id` and has row-level security forced, with both a read condition and a write condition, so a row cannot be inserted into, or moved to, another brand.
- It has a unique key on `(brand_id, id)`.
- **Every foreign key between brand-scoped tables includes `brand_id`.** A row in one brand therefore cannot point at a row in another, even if the ID is known.
- Identifiers are random, not sequential.

| Table | Key columns | Notes |
|---|---|---|
| `brand` | id, name, status, shadow_mode, schedule_key | Aztek and one test brand. `schedule_key` is a random value used only to group the brand's jobs in the queue. |
| `auth.*` | As generated by the sign-in library | Not brand-scoped |
| `membership` | user_id, brand_id, role | Roles from PRD 16.1. Platform owner is a flag on the user. |
| `invite` | id, brand_id, email, role, token_hash, expires_at, used_at | Single use |
| `content_item` | id, brand_id, kind, current_version_id | |
| `content_version` | id, brand_id, content_item_id, number, payload_canonical, hash, hash_scheme, created_by, created_at, provenance | **Immutable.** No update and no delete, enforced by trigger. See section 10. |
| `content_version_state` | content_version_id, brand_id, state, updated_at | **Mutable.** The lifecycle state of a version. |
| `content_version_state_change` | content_version_id, brand_id, from_state, to_state, cause, at | History; insert only |
| `asset` | id, brand_id, sha256, byte_length, mime, created_at | Immutable. Bytes are in the asset store under the hash. |
| `check_result` | id, brand_id, content_version_id, check, score, passed, detail | One placeholder check in phase 1 |
| `approval` | id, brand_id, content_version_id, version_hash, hash_scheme, decided_by, decision, comment, decided_at | Insert only |
| `approval_invalidation` | approval_id, brand_id, reason, at | Insert only. An approval is valid when no invalidation row exists. |
| `approval_request` | id, brand_id, content_version_id, requested_at, reminders_sent, last_reminder_at, escalated_at, escalated_to, overdue, closed_at | One row per version waiting for a decision |
| `approval_setting` | brand_id, first_reminder_after, reminder_gap, reminder_count | Per brand. Defaults: 24 hours, 24 hours, 3. Bulk and calendar settings are added in phase 3. |
| `popup_ack` | user_id, brand_id, approval_request_id, choice, at | Records "Review now" or "Later" on the overdue pop-up |
| `agent_definition_version` | id, agent, version, model, effort, files_hash, live | Not brand-scoped |
| `run` | id, brand_id, agent, definition_version_id, state, started_at, finished_at | |
| `job_input` | job_id, brand_id, run_id, input, saved_steps, result_hash | Brand-scoped. The queue never holds this. |
| `job_attempt` | id, job_id, brand_id, attempt_number, worker_id, state, started_at, ended_at | One row per claim. At most one active attempt per job. |
| `job_control` | job_id, brand_id, cancel_requested, held | Brand-scoped; read by the core, not by the queue role |
| `model_call` | id, brand_id, run_id, job_id, attempt_id, step, request_hash, status, provider_message_id, provider_request_id, model, token counts, cost, started_at, finished_at | The model-call ledger. One row per request sent to the provider (section 9.4). |
| `cost_ledger` | id, brand_id, run_id, agent, deliverable, model_call_id, cost | Cost per brand, agent and deliverable, written from `model_call` (P0-21) |
| `kill_switch` | brand_id, scope, target, on, set_by, at | |
| `audit.log` | id, brand_id, seq, at, actor, action, subject, before, after, prev_hash, hash | Insert only |
| `audit.export` | id, brand_id, through_seq, chain_hash, exported_at, location | |
| `notification` | id, brand_id, user_id, kind, state, attempts, sent_at, provider_id | |
| `trigger_nonce` | nonce, received_at | For n8n replay protection |
| `outbox_action` | id, brand_id, kind, content_version_id, state | Created now; no outside call until phase 3 |

## 6. Database roles, row-level security and pooling

Implements architecture 5.

- **Roles created by migration:** migration, application, queue, audit-writer, owner-view, read-only. The connection role is added in phase 3.
- **Policies** have a read condition and a write condition on every brand-scoped table: the row's `brand_id` must equal the brand set for the current transaction. With no brand set, nothing matches and nothing can be written.
- **Row-level security is forced**, so it applies to the table owner too.
- **`withBrand`** opens a transaction, sets the brand for that transaction only, runs the work and commits. All business queries go through it. A lint rule and a test fail the build if one does not.
- **Pooling:** transaction-level pooling is safe because the brand setting never outlives its transaction.
- **Queue role:** rights on the `pgboss` schema only. It has no rights on any `app` table, including `brand`, `job_input` and `job_control`. A queue row holds a job ID, a class and the brand's scheduling key, and nothing else.
- **Platform owner's cross-brand screens** call named database functions under the owner-view role. Each call writes an audit entry.
- **Application role** cannot create or alter tables, and has no rights on the audit schema.

## 7. Sign-in, roles and permissions

- **Sign-in:** email and password, then an authenticator-app code.
- **Backup codes:** shown once at enrolment, each usable once. Using one is audited and notified to the user.
- **Enrolment is forced** at first sign-in for every role except Viewer. Until it is complete, only the enrolment screen is reachable (SEC-1).
- **No self-registration.** The platform owner or a brand admin invites users. An invite is single-use and expires after 72 hours. Only its hash is stored.
- **Password recovery:** a single-use emailed link that expires after 30 minutes. Resetting a password never skips the second factor, and it ends all of that user's sessions.
- **Lost second factor:** a backup code. If none is left, the platform owner resets the user's second factor, which is audited and notified. For the platform owner's own account there is a documented server-side procedure, also audited.
- **Sessions:** server-side, in a secure, same-site cookie, with an idle timeout. The second factor is asked again before changing roles, using the kill switch or exporting data.
- **Cross-site request protection:** same-site cookies, an origin check on every state-changing request, and a per-session token that the dashboard must send. A request missing any of these is refused.
- **Rate limits and lockout** on sign-in, recovery and invite acceptance. Each attempt is audited.
- **Permissions:** each row of the PRD 16.1 table is a named permission. Every core route declares the one it needs; a route with no declaration fails a test (SEC-2).

## 8. Core service API (phase 1)

| Area | Operations |
|---|---|
| Session | Sign in, second factor, backup code, recover password, sign out, current user |
| Brands | List own, read, set shadow mode (owner) |
| Users | Invite, accept invite, list, change role, remove, reset second factor |
| Content | Create item, add version, list, read with versions, state and checks |
| Approvals | Inbox list, approve, reject, comment, edit (creates a new version); overdue list; record a pop-up choice |
| Approval settings | Read and change reminder timing and count |
| Home | Results, progress, waiting and problems for the brands the user can see |
| Alerts | List open alerts and incidents; acknowledge |
| Agents | List definitions and live versions, list runs, read a run with jobs and cost |
| Jobs | Dead-letter list, requeue, cancel |
| Job attempts | Worker starts an attempt and receives the attempt token and input; records model calls and checkpoints; posts the result |
| Triggers | Signed endpoint for n8n |
| Kill switch | Read, set, release |
| Audit | List and filter, verify chain, export status |
| Health | Liveness, readiness, heartbeat |

All inputs are validated against a strict schema. All brand data access passes through `withBrand`.

## 9. Job queue

Implements architecture 7.

### 9.1 What the queue knows about a brand

- Each brand has a random `schedule_key`. It is not the brand ID and reveals nothing about the brand.
- Every job is sent with that key as its **group**. This is the one piece of tenant information in the queue, and it is what lets the queue limit and balance work per brand.
- A queue row therefore holds: a job ID, a class and a scheduling key. It holds no client content and no business input. Those are in `job_input`, which the queue role cannot read.
- The queue role cannot read the `brand` table, so it cannot turn a scheduling key back into a brand.

### 9.2 Rules and how each is met

| Rule | How phase 1 does it |
|---|---|
| Job created with its cause | The queue library's send is called inside the same transaction as the business change, together with the `job_input` row |
| Lease and visibility timeout | The library's job expiry, set per class |
| Heartbeat | The library's own automatic heartbeats. Each class sets the allowed gap; the worker refreshes at half that gap. A job whose worker stops beating is failed by the library and retried. |
| Attempts and waits | The library's retry limit and growing delay |
| Dead letter | A dead-letter queue per class; listed on the dashboard with requeue and cancel |
| Priority | One queue per class; workers drain higher classes first |
| Per-brand concurrency | The library's per-process group limit, keyed on the scheduling key. It is exact inside one worker process. Each process is given the brand's cap divided by the number of worker processes for that job class, so the total never exceeds the cap. The number of processes per class is fixed in configuration. The library's global group limit is not used: the trial showed it is exceeded when several job slots fetch at once. |
| Fairness | Every worker process runs several job slots, never one. A brand at its limit is skipped, so a large backlog in one brand cannot occupy slots needed by another. Strict rotation between brands is not built. Test 29 proves this, run with one worker process and with two. |
| Low-latency dispatch | Interactive and publishing queues use database notification, so a worker is woken when a job arrives. Listening needs its own long-lived database connection, which does not go through the transaction pooler. Polling remains as a backstop. Production and bulk queues poll. |
| Backpressure | The core checks queue depth before creating production and bulk jobs; a shared limiter slows workers on a provider rate limit |
| Cancellation | A flag in `job_control`, returned to the worker by the core before each model call, between steps and before posting a result |
| Kill switch, waiting jobs | The core cancels the brand's waiting jobs in the queue and marks them held in `job_control`. On release it sends them again. |
| Stuck jobs | The library's expiry and heartbeat handling; a watchdog alerts on long waits and over-long runs |

### 9.3 Initial settings

| Job class | Dispatch | Allowed heartbeat gap | Refresh | Expiry | Max attempts |
|---|---|---|---|---|---|
| Interactive | Notification, 2-second polling backstop | 60 seconds | 20 seconds | 5 minutes | 3 |
| Publishing | Notification, 2-second polling backstop | 60 seconds | 20 seconds | 10 minutes | 5 |
| Production | Polling every 2 seconds | 90 seconds | 30 seconds | 30 minutes | 3 |
| Bulk | Polling every 2 seconds | 90 seconds | 30 seconds | 2 hours | 3 |

These match architecture 7.2: a refresh every 20 or 30 seconds, and a job treated as abandoned after three missed refreshes. The per-brand caps start at 2 interactive, 2 publishing, 3 production and 1 bulk. Phase 1 runs one worker process per job class, so each process is given the whole cap. With more processes, the cap is divided between them; a cap smaller than the number of processes is not allowed.

### 9.4 Attempts and the attempt token

A job can be claimed more than once: after a crash, a lost heartbeat or an expiry. Each claim is an **attempt**, and only the current attempt may change anything.

1. A worker claims a job from the queue.
2. It calls the core to start an attempt, authenticating as a worker. The core confirms from the queue's own records that the job is active, ends any earlier attempt for that job, and creates a new `job_attempt` row.
3. The core returns the job's input and an **attempt token**.

| Token field | Content |
|---|---|
| Token ID | Unique per token |
| Job ID and brand ID | What it is for |
| Attempt ID | The one attempt it belongs to |
| Expected result type | The only kind of result it may post |
| Issued and expiry times | Expiry is the job class's expiry |

**The core accepts a call only when** the token's signature and times are valid, the attempt ID is the job's current attempt, and that attempt is still active. A worker whose attempt was replaced is refused, whatever its token's expiry says. The refusal is recorded.

**Posting a result is repeatable.** The same result posted again by the current attempt returns the first outcome and changes nothing. A different result for a finished job is refused.

**Kill switch during a running job.** A model call already in flight cannot be recalled. The worker sees the switch before posting. If a result is posted anyway, the core stores it as held: no content version, no further job and no notification until release.

### 9.5 Model calls: what is and is not guaranteed

The model provider is an outside system. A reply can arrive and the worker can stop before recording it. Phase 1 does not assume the provider removes duplicate requests.

**Guaranteed**

- A step with a recorded checkpoint is never repeated.
- A result is never applied twice.
- Every request sent to the provider has a row in `model_call`, written before the request is sent.

**Not guaranteed**

- That a job makes exactly one provider request. A crash between the provider's reply and the checkpoint can cause the retry to send the same request again, and to be charged again.

**How each call is recorded**

1. Before sending, the worker registers the call with the core: attempt ID, step and a hash of the request. The row's status is "started".
2. If a "succeeded" row already exists for the same job, step and request hash, the saved checkpoint is used and no request is sent.
3. If a "started" row exists from an earlier attempt with no outcome, the new call is flagged as a possible duplicate and proceeds.
4. After the reply, the worker sends the checkpoint. In one transaction the core saves the step, marks the call "succeeded", stores the provider's message ID and request ID and the token counts, and writes the cost.
5. A failed request is marked "failed" with the error.

**Reconciliation.** A job sweeps "started" rows older than the class's expiry and marks them "unknown". Unknown and possible-duplicate calls are listed on the dashboard and counted in a monthly comparison of the ledger with the provider's own usage figures. Automating that comparison needs an administrator key from the provider (owner item A12); without it the comparison is done by hand from the provider's console.

## 10. Content versions and approvals

Implements architecture 8.2.

### 10.1 Immutable payload, mutable state

- **`content_version` is the immutable record.** It holds the canonical payload and its hash. A trigger refuses every update and delete.
- **`content_version_state` holds the lifecycle state** from architecture 8.2 (draft, in checks, awaiting approval, approved, and so on). It changes; the payload does not.
- State, check results, approvals and provenance are **outside** the hash. Changing them never changes what would be published.

### 10.2 Hash scheme `cv1`

| Element | Rule |
|---|---|
| Algorithm | SHA-256 over the UTF-8 bytes of the canonical payload. Stored as `sha256:` followed by 64 lowercase hexadecimal characters. |
| Scheme label | `hash_scheme = cv1` is stored beside every hash and every approval. A future change to these rules gets a new label; old versions keep theirs. |
| Canonical form | JSON in the JSON Canonicalization Scheme (RFC 8785): object keys sorted, no insignificant whitespace, one fixed way to write strings and numbers. |
| Numbers | Integers only. No decimals anywhere in the payload. |
| Times | Text in UTC, to the second, in the form `2026-10-04T06:30:00Z`. |
| Absent values | An absent optional field is left out. `null` and empty strings are not allowed. |
| Where it is computed | Only in `packages/canonical`, used by the core service. The database independently recomputes SHA-256 over `payload_canonical` in a trigger and refuses a row whose hash does not match. |
| What is published | In phase 3, the connection service publishes exactly what it parses from `payload_canonical`. Nothing outside the hashed bytes can reach a platform. |

### 10.3 Fields inside the hash

Every field that can affect what is published, to whom, or where, is inside.

| Field | Content |
|---|---|
| `schema` | `content-version/1` |
| `brand_id`, `content_item_id` | Identity of the item |
| `kind` | Article, post, video, email, reply, and so on |
| `language` | Language tag |
| `targets` | List of destinations: platform, connection ID and format. Empty in phase 1. |
| `title`, `summary`, `body` | Text. `body` is a list of typed blocks from a small permitted set. |
| `caption`, `hashtags`, `call_to_action` | Where the kind uses them |
| `links` | Each link's normalised address and its role |
| `assets` | Each asset's ID, SHA-256, byte length, media type, role and alt text |
| `fact_refs` | Each verified fact relied on: fact ID and the hash of that fact's text |
| `disclosures` | Flags such as "contains AI-generated visuals" |
| `publish_window` | Earliest and latest time the item may go out, if the approver set one |
| `kind_specific` | Further fields defined per kind in a strict schema, for example ad audience and budget reference in a later phase |

**Outside the hash:** the version's ID and number, state, creation time and author, check results, approvals, run and job IDs, cost, and provenance.

### 10.4 Normalisation, applied before hashing

The stored payload is the normalised one, so the hash covers the exact text that would be published.

| Topic | Rule |
|---|---|
| Unicode | All text is converted to Normalisation Form C. |
| Line endings | Converted to a single line-feed character. |
| Whitespace | Single-line fields are trimmed at both ends. Inside `body`, whitespace is kept exactly. Nothing is collapsed silently. |
| Disallowed characters | Control characters other than line feed and tab, byte-order marks, and invisible direction or zero-width characters are **rejected**, not removed. The version is not created. |
| Ordered lists | `body` blocks, `assets`, `links` and `hashtags` keep their order, because order shows in the published item. |
| Unordered lists | `targets`, `fact_refs` and `disclosures` are sorted by a fixed key. Duplicates are rejected. |
| Assets | An asset's hash is SHA-256 over the stored bytes after re-encoding, which are the bytes that will be published. Asset rows are immutable. |
| Links | Parsed and written back by the standard URL rules: lower-case scheme and host, international names in their ASCII form, default port removed. Only `https` is allowed. Addresses containing a user name or password are rejected. Path, query and fragment are kept as written. |
| Link destinations | The hash covers the address as written. Where a link redirects, the final destination is recorded at check time and checked again at publish time (phase 3); a different destination invalidates the approval. |

**Test vectors.** `packages/canonical` ships a file of payloads with their expected canonical text and hash, including awkward cases: accented text in both Unicode forms, mixed line endings, reordered keys, reordered unordered lists, and a rejected invisible character. The same vectors are run against the database trigger.

### 10.5 Approval rules

- An approval stores the version ID, the hash and the scheme.
- The approve request must carry the hash the approver saw. If it differs from the stored hash, the request fails. A stale screen cannot approve newer content.
- Any edit creates a new version with a new hash. The earlier version's state becomes superseded, and its approval does not apply to the new version.
- Approving writes the approval, the state change and an `outbox_action` in one transaction. In phase 1 the action's kind is "none" and it is confirmed with no outside call. This exercises the path phase 3 uses for publishing.
- Invalidating an approval inserts an `approval_invalidation` row; the approval row itself is never changed.
- A notification is sent when a version reaches "awaiting approval".
- Every state change is audited.

### 10.6 Reminders, escalation and overdue items

Implements App flow sections 4, 7 and 7.1.

- When a version reaches "awaiting approval", an `approval_request` is opened.
- A recurring job checks open requests every 15 minutes.
- **Reminders.** After the brand's first-reminder time, a reminder is sent to the brand's approvers. Further reminders follow at the brand's gap, up to the brand's count. Defaults: 24 hours, 24 hours, 3.
- **Escalation.** After the last reminder's gap has passed, the request is marked overdue and escalated: from a brand approver to the brand admin, then to the platform owner. Where the platform owner is already the approver, it is marked overdue only.
- **Silence is not approval.** Reminders and escalation never approve, reject or publish anything. An overdue version stays in "awaiting approval" until a person decides.
- **Pop-up.** A user who can approve an overdue item sees a window listing overdue items when one becomes overdue and at each sign-in while any remain. It offers "Review now" and "Later" and cannot be closed otherwise. The choice is recorded.
- **Banner.** Every dashboard screen for that brand shows "N items overdue for approval" with a link to the inbox filtered to them, until none remain. "Later" does not remove it.
- **Settings.** Reminder timing and count are changed on the Approval settings screen by the platform owner or a brand admin, and take effect for open requests from the next check.
- A decision on the version closes its request and clears the pop-up and banner for it.

## 11. The trivial agent

Its purpose is to prove the run path, the token path, the cost path and the audit path.

1. The owner enters a short brief for a brand and starts the "summary" agent.
2. The core creates a run, a job and its input in one transaction.
3. A worker claims the job, starts an attempt, and receives the input and an attempt token.
4. It registers the model call, makes one structured call (summarise the brief in two sentences and list three keywords), and sends the checkpoint.
5. It posts the result. The core validates it, builds the canonical payload, stores content version 1, and writes the cost from the model-call ledger.
6. The placeholder check runs as a separate job and passes anything under a length limit.
7. The item reaches the inbox, a notification email is delivered, and the owner approves it.
8. The run, its jobs, its cost and its audit entries are visible on the Agents and Audit screens.

The brief is untrusted input: it is wrapped, the step has no tools, and the result is validated before storage.

## 12. Audit log

Implements architecture 13.8 and SEC-8.

- **Written by the core** through the audit-writer role for every sign-in and failure, recovery, invite, permission change, content change, approval, person-made job change, kill-switch change, export and cross-brand read.
- **Hash chain per brand**, plus one chain for platform-level entries. Each entry's hash covers its content, its sequence number and the previous entry's hash.
- **Concurrent writes.** Appending takes a per-chain lock for the length of the transaction, so two writers cannot both extend the same previous entry. Sequence numbers have no gaps and no duplicates.
- **No update or delete** for any role, enforced by missing rights and by a trigger.
- **Export job,** daily, to write-once storage outside the server: new entries and each chain's latest hash.
- **Verify job,** daily: recomputes each chain and compares it with the exported hashes. A mismatch raises a severity 1 alert.
- **Screen:** filter by brand, actor, action and time; a "verify now" action.

## 13. Kill switch and shadow mode

- **Kill switch** at three scopes: brand, channel, agent. Setting or releasing it needs the kill-switch permission and a fresh second factor, and is audited.
- Workers check it before every job, before every model call and before posting a result (section 9).
- Setting it moves the brand's waiting jobs to held. Releasing it returns them to ready.
- **Shadow mode** is a flag on the brand. In phase 1 it is stored and shown; it takes effect in phase 3.
- Both are usable on a phone-sized screen.

## 14. n8n

One new workflow, `Marketing — daily heartbeat`, proves the n8n-to-core path. A second new workflow, `Marketing — canary`, does nothing but record its own run time; it is used to measure whether the product affects n8n (section 17, test 41). `Sarathi Access Sync` and `Sarathi — Jira CEO snapshot` are not opened or changed.

**Signed request format**

| Part | Rule |
|---|---|
| Headers | `X-Mkt-Timestamp` (seconds since 1970), `X-Mkt-Nonce` (32 random bytes as hexadecimal), `X-Mkt-Signature` |
| Text that is signed | Five lines joined by a line feed: the method in upper case; the path exactly as sent, with no query string allowed; the timestamp; the nonce; the SHA-256 of the raw body as lowercase hexadecimal |
| Signature | HMAC-SHA256 of that text with the shared secret, as lowercase hexadecimal, compared in constant time |
| Timestamp window | 5 minutes either side of the server's clock |
| Nonce | Stored on first use. A repeat inside 10 minutes is refused. Entries older than 10 minutes are deleted; by then the timestamp check refuses the request anyway. |
| Scope | The credential can call trigger endpoints only. It can read nothing. |

The secret is an n8n credential, never a workflow field. Workflows are built and validated through the n8n-mcp tools and exported to `n8n/`.

## 15. Dashboard screens

| Screen | Contents |
|---|---|
| Sign-in, enrolment, recovery, invite acceptance | Password, second factor, backup codes |
| Home | Four blocks in this order: results, progress, waiting for you, problems. In phase 1 there are no marketing results yet, so "results" shows the trivial agent's runs and cost and "progress" shows job progress. |
| Approval inbox | Preview, versions, check results, approve, reject, comment, edit |
| Agents | Definitions and live versions, runs, jobs, cost per run |
| Dead letters | Failed jobs with requeue and cancel |
| Audit | Filterable log, chain verification status |
| Settings | Brand, users and roles, kill switch, shadow mode, approval settings |
| Alerts and incidents | Open alerts with acknowledge; links to dead letters and audit |
| On every screen | Status banner (kill switch, shadow mode, overdue approvals); overdue pop-up; stop button |

The inbox, the kill switch, alerts and the overdue pop-up work on a phone.

## 16. Deployment, notifications and monitoring

| Item | Phase 1 |
|---|---|
| Server | The shared server, after inspection |
| Containers | dashboard, core, worker, postgres; each with processor and memory limits |
| Networks | Separate container networks for the application, worker and data zones |
| Address | `marketing.sarathi.gvcc.in` with TLS |
| Secrets | Injected at start from a secrets file with restricted permissions; never in the repository, images or logs |
| Backups | Daily encrypted backup of the whole database (all four schemas), copied off the server |
| Restore test | A backup is restored into a clean database and the tests in section 17 are run against it |
| Notifications | Email through the sending account. Each notification has a state, an attempt count and the provider's message ID; failures are retried and then alerted. |
| Alerts | Sent by email and by a second, independent channel (owner item A11). An alert counts as delivered only when the provider confirms it. |
| Monitoring | Uptime check, error tracking, failed jobs, dead letters, missing worker heartbeat, missing n8n heartbeat, audit chain mismatch, notification failures |

Owner prerequisites are listed in `docs/sachin-to-provide.md`, section 1. None blocks development; all block deployment.

## 17. Acceptance tests

Gate 0 passes when all of these pass.

**Tenant isolation**

| # | Test | Covers |
|---|---|---|
| 1 | With a session for brand A, every API operation refuses or returns nothing for brand B's records | P0-1 |
| 2 | With each database role, a direct query cannot read another brand's rows; with no brand set, no rows are returned | P0-1 |
| 3 | With brand A set, an insert carrying brand B's ID is refused, and an update that changes a row's brand to B is refused | Write conditions |
| 4 | A row in brand A cannot be made to reference a parent row in brand B, for every foreign key between brand-scoped tables | Section 5 |
| 5 | The queue role cannot read `job_input`, `brand` or any business table. A queue row contains no client content or business input: only a job ID, a class and a scheduling key. | Sections 6, 9.1 |
| 6 | An attempt token for job A cannot fetch job B's input, in the same brand or another | Section 9.4 |
| 7 | A business query made outside `withBrand` fails the build | Architecture 5 |

**Sign-in and permissions**

| # | Test | Covers |
|---|---|---|
| 8 | A user in any role except Viewer cannot reach any screen but enrolment until a second factor is set. A Viewer signs in with email and password and can read only. | SEC-1, App flow 5.1 |
| 9 | A backup code works once and never again; its use is audited and notified | Section 7 |
| 10 | Password recovery: the link works once, expires after 30 minutes, ends existing sessions, and still requires the second factor | Section 7 |
| 11 | An invite is refused after 72 hours and after its first use | Section 7 |
| 12 | A state-changing request with a wrong origin, without the session token, or sent from another site is refused | Section 7 |
| 13 | Every route declares a permission; each role is allowed and denied exactly as PRD 16.1 states | SEC-2 |

**Content and approvals**

| # | Test | Covers |
|---|---|---|
| 14 | Every test vector produces the expected canonical text and hash, in the application and in the database trigger | Section 10 |
| 15 | Any update or delete on `content_version` is refused for every role | Section 10.1 |
| 16 | A row whose hash does not match its payload is refused by the database | Section 10.2 |
| 17 | Changing any hashed field produces a different hash; changing state, checks or provenance does not | Section 10.3 |
| 18 | Approving with a stale hash fails; after an edit, the old approval does not apply to the new version | Section 10.5 |
| 19 | Approval, state change and outbox action are written together or not at all | Architecture 10.1 |
| 20 | With default settings, a waiting item gets reminders at 24, 48 and 72 hours and no more; after a further 24 hours it is marked overdue and escalated. Tested with a controlled clock. | Section 10.6 |
| 21 | An overdue item is still "awaiting approval": no approval row, no outbox action and no state change is created by reminders or escalation, however long it waits | Section 10.6 |
| 22 | The overdue pop-up appears when an item becomes overdue and at each sign-in while any remain; it closes only by "Review now" or "Later"; the banner stays after "Later" and clears only when the item is decided | Section 10.6 |
| 23 | Changing a brand's reminder count or timing changes the next reminders for open requests; only the owner or a brand admin can change them | Section 10.6 |

**Queue and workers**

| # | Test | Covers |
|---|---|---|
| 24 | A worker killed mid-job: the library detects the missing heartbeat, the job is claimed again as a new attempt, and every step with a checkpoint is skipped | Section 9.2, 9.5 |
| 25 | A worker killed after the model replied but before the checkpoint: the retry sends the request again, the new call is flagged as a possible duplicate, both calls are in the model-call ledger, and only one result is applied | Section 9.5 |
| 26 | An attempt that lost its lease posts a result after the job has been reclaimed: it is refused and recorded, and the new attempt's result is the one applied | Section 9.4 |
| 27 | The same result posted twice by the current attempt changes nothing the second time; a different result for a finished job is refused | Section 9.4 |
| 28 | A job that keeps failing lands in the dead-letter list and can be requeued | Architecture 7 |
| 29 | Brand A has 500 waiting production jobs. Interactive and production jobs for brand B are still claimed within their class limits, and brand A never runs more than its group limit at once. | Section 9.2 |
| 30 | Kill switch set while jobs wait: they are held and no model call is made; release sends them again | P0-18, P0-24 |
| 31 | Kill switch set while a job is running: the result is held; no content version, further job or notification is created | Section 9.4 |
| 32 | An expired attempt token, a token for another job, and a token with a tampered field are all refused | Section 9.4 |

**n8n, audit and operations**

| # | Test | Covers |
|---|---|---|
| 33 | An n8n request is refused when: the signature is wrong; the body, path, method, timestamp or nonce differs from what was signed; a query string is present; the timestamp is outside 5 minutes; the nonce repeats | Section 14 |
| 34 | A nonce older than 10 minutes is removed from the store, and a request reusing it is still refused by the timestamp check | Section 14 |
| 35 | Update and delete on the audit log are refused for every role; an altered entry is detected by verification | SEC-8 |
| 36 | Fifty concurrent audit writes to one brand produce one unbroken chain with no gap or duplicate in sequence | Section 12 |
| 37 | The trivial agent runs end to end; its model call and cost are in the ledger against the brand and its audit entries are complete | P0-21 |
| 38 | A notification and an alert each arrive in a real inbox and on the second channel, and the provider's confirmation is recorded | Section 16 |
| 39 | No secret appears in the repository history, in any container image layer, or in logs produced during the full test run | SEC-6 |
| 40 | A backup restores into a clean database with all four schemas: a user can sign in with a second factor, waiting jobs resume, the audit chain verifies, and tests 1 to 6 pass | REL-1, gate 0 |
| 41 | Load test, below | REL-13 |

**Test 41: load and impact on n8n**

The processor and memory figures are proposals until the server has been inspected (owner item A1). They are then fixed here before the test is run.

| Aspect | Criterion |
|---|---|
| Workload | Two brands. 300 trivial-agent jobs submitted evenly, with the model replaced by a stand-in that answers in 2 seconds. Ten simulated dashboard users, each making one request a second. |
| Duration | 30 minutes |
| Product limits | All product containers together stay within 2 processor cores and 4 GB of memory. No container is restarted or stopped for lack of memory. |
| Server | Average processor use below 80 percent. No swapping. |
| Core API response | 95 percent of requests under 500 milliseconds; 99 percent under 1.5 seconds |
| Queue, interactive | One interactive probe job is submitted every 10 seconds throughout. 95 percent are claimed within 1 second of being sent. This relies on notification dispatch (section 9.2). |
| Queue, production | Every production job is claimed within 5 seconds of a slot being free for its brand. All 300 jobs finish inside the test. No job is in the dead-letter list. |
| Impact on n8n | The canary workflow, run every minute, takes no more than 20 percent longer than its average over the hour before the test. No n8n execution fails during the test. |

## 18. Work packages

Sizes are relative: S small, M medium, L large.

| # | Package | Size | Depends on |
|---|---|---|---|
| 0 | Technology trial and version pinning: confirm the pinned stack works together; confirm the queue library's heartbeats, group concurrency, notification dispatch and send-inside-a-transaction behave as section 9 assumes; record results in section 3 | M | — |
| 1 | Repository, workspaces, build, test, lint and secret scanning | S | 0 |
| 2 | Database migrations, roles, row-level security with write conditions, brand-scoped foreign keys, `withBrand`, isolation tests | L | 1 |
| 3 | Core service shell: HTTP framework, strict validation, error handling, logging with redaction, health endpoints, cross-site request protection | M | 1, 2 |
| 4 | Sign-in: generated schema as a migration, second factor, backup codes, invites, recovery, sessions | M | 2, 3 |
| 5 | Permissions and route-declaration tests | M | 4 |
| 6 | Audit log, hash chain with locking, export and verify jobs | M | 2, 3 |
| 7 | Queue interface over the library: classes, group concurrency, heartbeats, notification dispatch, dead letters, watchdog, held jobs | M | 0, 2 |
| 8 | Worker, attempts and attempt tokens, repeatable results, model-call ledger with reconciliation, cost ledger | L | 3, 7 |
| 9 | Canonical payload package, test vectors, database hash trigger | M | 2 |
| 10 | Content versions, state, approvals, outbox write | M | 5, 6, 9 |
| 11 | Notification delivery and alert delivery, with a second channel | M | 3 |
| 12 | Kill switch and shadow flag | S | 5, 6, 7 |
| 12a | Approval requests, reminders, escalation, approval settings | M | 10, 11 |
| 13 | Trivial agent end to end | S | 6, 8, 10, 11 |
| 14 | n8n heartbeat and canary workflows; signed trigger endpoint | S | 3, 5 |
| 15 | Dashboard screens, including Home blocks, the overdue pop-up and banner, approval settings and alerts | L | 4, 5, 6, 7, 8, 10, 11, 12, 12a, 13 |
| 16 | Compose file, limits, proxy, secrets, backups, restore script | M | Server inspection |
| 17 | Monitoring | S | 11, 16 |
| 18 | Acceptance run for gate 0 | M | All |

## 19. Risks

| # | Risk | Response |
|---|---|---|
| 1 | The per-process limit does not keep one brand from delaying another under real load | The trial showed it does at small scale. Test 29 decides at full scale. If it fails, add rotation between brands, or fall back to our own job table behind the same interface. |
| 2 | A pinned version does not work with another, or the pinned queue release lacks a feature section 9 relies on | Package 0 confirms the set and each queue feature; any substitution is recorded here and in the Tech stack document before other work starts |
| 3 | The shared server has too little headroom | Inspect before deployment; move to a separate server if so |
| 4 | Row-level security is bypassed by a forgotten code path | Forced policies, write conditions, brand-scoped foreign keys, the `withBrand` build check and role-level tests |
| 5 | Two places compute the canonical form differently | Only one library produces the canonical text. The database hashes those exact stored bytes and refuses a mismatch. Shared test vectors cover both. |
