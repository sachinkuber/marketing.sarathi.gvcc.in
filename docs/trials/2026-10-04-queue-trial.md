# Queue Library Trial — Findings

| Document control | |
|---|---|
| Date | 2026-10-04 |
| Prepared by | Claude Code |
| Purpose | Check, before the milestone 1 task plan is written, that the queue library behaves as Phase 1 spec version 4, section 9, assumes |
| Status | Acted on. The owner approved Phase 1 spec version 5 on 2026-10-04, which makes the change in section 5. |

## 1. What was tested

Throwaway scripts in a scratch folder, not in this repository, run against a real database. Milestone 1 turns each check into a permanent test.

| Item | Value |
|---|---|
| Queue library | pg-boss 12.30.0, the pinned version |
| Database | PostgreSQL 17.11, official image, digest `sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f` |
| Query builder | Kysely 0.29.5 |
| Runtime | Node 22.23.1, the version on this machine. The pinned Node 24.20.0 is not installed yet; milestone 1 repeats the checks on it. |

## 2. Results

| # | What the spec assumes | Result | Evidence |
|---|---|---|---|
| 1 | A job can be created inside the same transaction as a business change | **Confirmed** | After a rolled-back transaction: 0 jobs. After a committed one: 1 job. |
| 2 | A job whose worker stops sending heartbeats is taken back and retried | **Confirmed** | With a 10-second allowed gap, a silent job moved from active to retry after 11.1 seconds |
| 3 | A job that keeps failing ends in the dead-letter queue | **Confirmed** | 2 attempts with a retry limit of 1, then 1 job in the dead-letter queue |
| 4 | Notification dispatch wakes a worker quickly | **Confirmed** | 5 jobs claimed 6 to 15 milliseconds after being sent, against a 2-second polling interval |
| 5 | The per-group concurrency limit is enforced in the database across all workers | **Not confirmed** | See section 3 |

## 3. The per-brand limit

The spec says a brand's concurrency cap is "enforced in the database across all workers". The library has two settings, and they cannot be used together.

**Global limit (`groupConcurrency`).** Meant to cap a group across every worker. With a limit of 2 and 30 waiting jobs for one brand:

| Workers | Peak at start | Peak afterwards |
|---|---|---|
| One process, six job slots | 5 | 3 |
| Three processes, six job slots each | 12 | 4 |

It is a soft limit. When several slots fetch at the same moment, each sees room under the limit and all of them take a job. It settles close to the limit later, but it does not hold it.

**Per-process limit (`localGroupConcurrency`).** Caps a group inside one worker process. With a limit of 2:

| Workers | Peak at start | Peak afterwards |
|---|---|---|
| One process, six job slots | 2 | 2 |
| Three processes, six job slots each | 6 | 6 |

It is exact inside a process. Across processes the total is the per-process limit times the number of processes: predictable, and never exceeded.

**Fairness.** In every multi-slot run, the second brand's first job started within about half a second while the first brand had 30 jobs waiting. A single job slot is the exception: it works strictly in order, and the second brand waited 10 seconds.

## 4. What this means

- The goal in the spec still holds: one brand's backlog must not delay another, and a brand must not exceed its cap.
- The mechanism in the spec does not deliver the second half strictly.
- **Recommended change:** use the per-process limit. Set it to the brand's cap divided by the number of worker processes for that job class. Phase 1 runs one worker process per class, so the cap is exact. The number of processes is fixed in configuration, so the total stays known when more are added.
- Every worker process runs several job slots, never one, so a second brand is never stuck behind the first.
- Acceptance test 29 stays as written. It now proves the per-process limit, and is run with one worker process and with two.

## 5. What needs to change in approved documents

| Document | Change |
|---|---|
| Phase 1 spec version 4, section 9.2, rows "Per-brand concurrency" and "Fairness" | Replace "enforced in the database across all workers" with the per-process limit described above |
| Phase 1 spec version 4, section 9.3 | State that the starting caps are per worker process, with one process per class in Phase 1 |
| Architecture version 2, section 7.1, row "Per-brand concurrency" | No change needed; it states the rule, not the mechanism |

This is a new version of the Phase 1 spec (version 5) and needs the owner's approval, like every other change to an approved document.

## 6. Not yet checked

| Item | When |
|---|---|
| All of the above on Node 24.20.0 | Milestone 1 |
| The model provider's library with `claude-opus-5-5` | Milestone 1 if an API key is available (owner item A3); otherwise before milestone 4 |
| The sign-in library generating its tables as SQL | Milestone 2 |
| The complete pinned set installing and type-checking together | Milestone 1 |
