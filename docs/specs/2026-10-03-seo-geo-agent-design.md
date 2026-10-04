# SEO-GEO Agent (n8n Automation Layer) — Design Spec

**Date:** 2026-10-03
**Status:** Design approved conversationally; pending written-spec review, then implementation plan

## 1. Context

This is **Sub-project 3** of the three-part AI marketing initiative for Aztek (aztek.global):

1. Technical SEO/GEO Foundation — **live in production** (sitemap, robots, `llms.txt`, per-page metadata, JSON-LD).
2. Content Pipeline — **live in production** (`Article`/`Tag` Prisma models, admin editor, Draft/Published queue, dynamic `/insights`).
3. **Automation Layer (this spec)** — an n8n-orchestrated agent that performs the recurring SEO and GEO work end-to-end, pausing for human approval wherever something customer-facing or irreversible would happen.

**Goal.** The user supplies a website's details once and triggers one "SEO-GEO Agent". The agent runs the whole job — audit, research, planning, drafting, publish preparation, monitoring, GEO citation tracking, reporting — and asks the user for approval at defined gates. It resumes automatically after each approval.

**Standing rules carried into this design**

- AI drafts and researches; **a human approves before anything goes live**. Approving a draft does not publish it — it lands as a `Draft` in the site admin and the user performs the final publish.
- **No invented facts.** No statistics, client names, certifications or superlatives that are not in the site's verified-facts list (prior incidents: fabricated "500+ Partners", unverifiable "only global protection network" claim).
- The user explicitly rejected a visible NAP block in the footer. The agent must never propose re-adding it without being asked.
- **Do not touch the existing workflows** on `n8n.sarathi.gvcc.in` (`Sarathi Access Sync`, `Sarathi — Jira CEO snapshot`). All new work is new workflows only.
- Production DB writes (if any ever become necessary) require a `pg_dump` backup first. The agent itself never writes to the DB directly — see section 5.

## 2. Scope and phasing

The work is split into four phases, each independently testable and deliverable.

| Phase | Deliverable | Stages covered |
|---|---|---|
| **0** | Draft-only intake endpoint on the site, n8n Data Tables, Aztek site profile | Foundations |
| **1** | Orchestrator + Audit, Research, Plan, Draft stages, with approval gates 1-3 | Stages 1-4 |
| **2** | Publish-prep checks, Monitor, Report | Stages 5-6 and 8 |
| **3** | GEO citation tracker, outreach drafts, gate 4 | Stage 7 and 9 |

**Out of scope (v1):** auto-publishing; sending outreach emails; creating/managing Google Business Profile; writing real case studies; any CMS adapter other than Aztek's; paid keyword tools (design leaves room for one, see section 9).

## 3. Architecture

### 3.1 Orchestrator and site profile

One **orchestrator workflow** is the entry point. A run is created from a **site profile** and a trigger.

**Trigger:** an n8n Form Trigger (the user fills the form) or a Webhook (the user asks Claude in the terminal, and Claude calls the webhook). Both create the same run record.

**Site profile fields**

| Field | Purpose |
|---|---|
| `siteUrl`, `brandName`, `alternateNames` | Identity (currently "Aztek Global", alternate "Aztek") |
| `services[]`, `locations[]` | What to rank for and where |
| `competitors[]` | Gap analysis inputs (UltrashieldX, Cosmo PPF/Sunshield, Intakt PPF, XPEL, 3M India) |
| `gscProperty` | Search Console property (`sc-domain:aztek.global`) |
| `adapter` | How drafts are delivered (`aztek-articles-endpoint` in v1) |
| `toneGuide`, `forbiddenClaims[]` | Writing rules |
| `verifiedFacts[]` | The only facts a draft may state as fact (e.g. "100+ certified studios", "50+ Partners", "5 Countries") |
| `approverEmail` | Who receives approval requests (`sachin@gvcc.in`) |
| `dryRun` | If true, produce everything but write nothing |

### 3.2 Stages (each a sub-workflow)

The orchestrator calls each stage as an Execute Workflow sub-workflow with defined inputs and outputs, so stages are testable alone.

1. **Audit** — fetch the live site (homepage + sitemap URLs): titles, meta, headings, schema presence, `llms.txt`, robots, canonical/redirects, PageSpeed API scores. Output: structured findings list.
2. **Research** — pull GSC queries/pages for the property; find near-ranking queries (positions ~8-30), pages with impressions but low CTR, and topics with no page. Add competitor topic gaps from the profile's competitors.
3. **Plan** — merge research into a prioritised content queue: target keyword, search intent, working title, suggested internal links, rationale.
4. **Draft** — for each approved topic, an LLM writes the article from a brief plus the profile's tone, forbidden claims and verified facts, then a verification pass checks every claim against the verified-facts list. Output: title, slug, excerpt, body, tags, cover-image alt text.
5. **Publish-prep** (Phase 2) — after the user publishes: verify the URL returns 200, appears in `sitemap.xml`, has valid Article JSON-LD; ping IndexNow; suggest internal links from existing articles.
6. **Monitor** (Phase 2) — scheduled weekly: GSC clicks/impressions/position trend, PageSpeed on top pages, broken-link check, sitemap/robots/`llms.txt` sanity check.
7. **GEO check** (Phase 3) — scheduled weekly: run a fixed prompt set against AI engines (ChatGPT, Perplexity, Gemini, Claude), record whether Aztek is mentioned or cited and which competitors are cited instead.
8. **Report** (Phase 2) — weekly digest email plus a trend log.
9. **Outreach drafts** (Phase 3) — draft (never send) directory-listing and roundup-article outreach texts.

### 3.3 Run state

State lives in **n8n Data Tables** so runs can pause for days across approvals.

| Table | Contents |
|---|---|
| `seo_site_profiles` | One row per site (fields in 3.1) |
| `seo_runs` | Run id, profile, stage, status, timestamps, dry-run flag |
| `seo_content_queue` | Topic, keyword, intent, status (`proposed` / `approved` / `drafted` / `in_review` / `delivered` / `rejected`), revision count, draft payload |
| `seo_approvals` | Gate, item, decision, feedback text, decided-at |
| `seo_metrics` | Weekly monitor and GEO results for trend reporting |

### 3.4 Approval gates

Approvals use n8n's **send-and-wait-for-response** step on Gmail (default; Slack/Telegram are drop-in alternatives). The run pauses until the approver replies.

| Gate | Approver decides | Outcomes |
|---|---|---|
| **1** | The content plan (topics and keywords) | Approve all / approve subset / reject with notes |
| **2** | Each draft | Approve / reject / feedback → redraft (max 2 revision rounds, then escalate to manual) |
| **3** | The audit's technical-fix list | Approve items for implementation |
| **4** (Phase 3) | Outreach and directory drafts | Approve for the user to send manually |

**Gate 3 limitation:** n8n cannot edit the repository. An approved fix list becomes a report; the actual code changes are carried out by Claude in a Claude Code session, with the normal commit/deploy process and its own confirmations.

## 4. Data flow (Phase 1 happy path)

1. User triggers the agent for the Aztek profile.
2. Audit and Research run; Plan produces the queue.
3. **Gate 1:** email with the proposed topics → user approves a subset.
4. Draft runs per approved topic and passes the fact-verification pass.
5. **Gate 2:** email per draft with full text → user approves.
6. The Aztek adapter POSTs the draft to the site endpoint → a `Draft` article appears in the admin editor, flagged as automation-created.
7. The user reviews in admin and publishes manually.
8. (Phase 2) Publish-prep and monitoring pick it up from there.

## 5. Site-side change: draft-only intake endpoint (Phase 0)

A new route in the Next.js app: `POST /api/automation/articles`.

- **Authentication:** a long random bearer key held in the production `.env` (read at runtime, server-side only — no `NEXT_PUBLIC_` variable, so the Docker build-arg gotcha does not apply) and stored in n8n as a credential. Constant-time comparison. Missing/invalid key returns 401.
- **Capability:** creates an `Article` with `status = Draft` **only**. The payload cannot set status, `publishedAt` or any publish field; the route ignores them. There is no update-to-published path through this endpoint.
- **Validation:** reuses the existing article validation schemas and slug generation/collision handling from the content pipeline; unknown tags are rejected or created per existing tag rules (to be confirmed against `lib/` in the plan).
- **Provenance:** a nullable `Article.source` (or equivalent) marks automation-created drafts so the admin can show an "AI draft" badge. This is a small additive migration (backup + the repo's `prisma migrate diff` workflow).
- **Abuse limits:** body-size cap and a basic rate limit.
- **Scripts rule:** any helper script that runs inside the production container must be self-contained (no imports from `lib/`).

Deploy follows the existing procedure: pull, build, up; verify the endpoint returns 401 without a key and creates exactly one Draft with a valid key; the production DB backup precedes any migration. Staging is optional for this additive change per the user's standing preference.

## 6. Guardrails

- **Draft-only by construction** — enforced server-side, not just by agent discipline.
- **Verified-facts rule** — the Draft stage's verification pass fails any draft containing a numeric or superlative claim not in `verifiedFacts[]`; failures are redrafted before the user ever sees them.
- **Forbidden claims** — profile-level list checked in the same pass.
- **Dry-run mode** — full run, no writes, results shown in the approval email.
- **Audit log** — every run, gate decision and delivery is stored in `seo_runs`/`seo_approvals`.
- **Secrets** — all API keys in n8n credentials, never in node parameters or Set nodes.
- **Isolation** — new workflows only, tagged `seo-geo-agent`; existing workflows untouched.
- **Error handling** — every fallible node gets an error branch; failures produce an alert email and mark the run `failed` rather than silently stopping.

## 7. Error handling

- **Gate timeout:** a gate with no reply for 7 days sends one reminder, then marks the run `waiting` (not failed) so it can still resume.
- **API failure** (GSC, PageSpeed, LLM, AI engines): retry with backoff, then skip that sub-step and flag it in the report; a stage is only `failed` if its core output is unavailable.
- **Endpoint failure on delivery:** the draft stays in `seo_content_queue` as `approved`, not lost; the run alerts and can retry delivery.
- **LLM output failure** (malformed/empty): one retry, then mark the item `needs_manual`.

## 8. Testing

- **Endpoint:** 401 without key; 201 with key creates exactly one Draft; attempts to set status/`publishedAt` are ignored; slug collision handled; oversize body rejected.
- **Each sub-workflow** tested alone with fixture input via `n8n_test_workflow`; ask the user before any run with real side effects.
- **Dry-run end-to-end** on the Aztek profile before the first real run.
- **Fact-verification pass** tested with a deliberately bad draft (fake statistic) that must be rejected.
- Validate every workflow (`n8n_validate_workflow`) and inspect `connections` after each create/update, per the n8n-mcp skills.

## 9. Credentials and prerequisites

| Needed | For | Phase |
|---|---|---|
| Gmail credential on n8n (send-and-wait) | Approvals, reports | 1 |
| Google credential with Search Console API scope | Research, monitoring | 1 |
| Anthropic API key | Drafting, verification pass | 1 |
| Automation API key (generated by us, in prod `.env` + n8n credential) | Draft intake endpoint | 0 |
| PageSpeed Insights API key (free) | Audit, monitoring | 1-2 |
| IndexNow key file served from the site | Publish-prep | 2 |
| API keys for ChatGPT, Perplexity, Gemini (Claude shares the Anthropic key) | GEO check | 3 |
| Optional: paid keyword tool (Ahrefs / DataForSEO) | Better volumes and competitor data | later |

**Budget stance:** free-first. The profile/research stage is designed behind an interface so a paid keyword source can be added later without redesign. Running cost is expected to be LLM/API usage only.

## 10. Risks and open decisions

- **Approval-email ergonomics:** long drafts inside an email may be hard to review; fallback is a link to the admin draft view with a short approve/reject email.
- **GEO measurement is noisy:** AI answers vary run to run; the tracker uses repeated runs and trends, not single results.
- **Shared branch:** `dev-yesu` has other contributors; read the full `git pull` diff before any deploy.
- **Open (non-blocking):** whether Gate 2 approval should deliver straight to admin Draft (default, as designed) or hold until the user also confirms delivery separately. Default stands unless the user says otherwise.
