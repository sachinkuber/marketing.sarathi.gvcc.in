# AI Marketing Agency Platform — Product Requirements Document

**Date:** 2026-10-03
**Status:** Master PRD v3, approved by the owner on 2026-10-04 for technical design, estimation and phased Aztek development, subject to resolution of the remaining launch blockers. Product name, baselines, deadline and budget are open (section 20). Recommended defaults awaiting confirmation are in section 21.
**Owner:** Sachin Tripathi. **First brand:** Aztek (aztek.global). **Dashboard:** marketing.sarathi.gvcc.in

## 1. Summary

A SaaS product that works as a complete marketing agency with no agency staff. A brand supplies its website and social media details. A team of AI agents, one for each role in a traditional agency, then researches the brand, asks a tailored questionnaire, sets strategy, creates content, runs social and paid campaigns, manages leads and tracks the sales cycle. People are involved only to approve work and to take over hot leads.

Aztek is the first brand. If the product meets the success criteria in section 13 for Aztek, the owner will redirect the existing marketing staff to other work and offer the product to outside clients in two tiers: self-serve and managed.

This document states what the product must do. How it is built (n8n workflows, data model, tool choices) belongs in the technical specs that follow it. The earlier SEO-GEO agent design (`2026-10-03-seo-geo-agent-design.md`) becomes one of those technical specs.

## 2. Problem statement

Marketing for the owner's brands is done today by a human marketing team. The owner wants that work done end to end by software so the team can be reassigned, and wants the same capability sold to other businesses as a product. Without it, marketing output is limited by headcount, and each additional brand needs more people.

No market research or customer interviews have been done for the outside-client offering. That is recorded as an open question, not assumed.

## 3. Goals

1. **Replace the manual marketing workload for Aztek.** The product produces and publishes content, runs campaigns and handles leads without marketing staff doing hands-on work.
2. **Match or beat the current team on leads.** Qualified leads per month are at least equal to the current baseline (baseline is an open question).
3. **Match or beat the current team on content.** Output volume is at least the current baseline, at a quality the approver accepts without heavy edits.
4. **Keep the owner's time small and fixed.** The owner's only routine work is approvals, within a daily time budget (value is an open question).
5. **Grow organic visibility.** Measurable growth in search traffic, rankings and mentions in AI answers.
6. **Be sellable.** A second brand and then outside clients can be onboarded by adding a tenant and its users, with no rebuild.

## 4. Non-goals (version 1)

- **Content in languages other than English.** The owner chose English only.
- **Editing a brand's main website.** Agents build campaign landing pages hosted by the product and recommend changes to the main site; they never edit it.
- **Fully AI-invented brand imagery as the only source.** Agents work from real photos and footage the brand uploads, and use AI generation to edit, repurpose and fill gaps.
- **Publishing or spending without an approval path.** Every customer-facing item and every budget has an approval or a pre-approved rule behind it.
- **Legal advice.** The legal agent flags risk and fills approved templates. It does not replace a lawyer.
- **Physical production.** The product does not shoot photos or video; it can write a shot list for the brand to shoot.

## 5. Users and roles

| Role | Who | What they do in the product |
|---|---|---|
| **Platform owner** | Sachin | Sees every brand. Approves everything for Aztek and 11oils. Manages tenants, budgets and kill switches. |
| **Brand approver** | A named person at an outside client | Gets a notification, reviews and approves or rejects that brand's items. Sees only their own brand. |
| **Brand sales contact** | A named salesperson at the brand | Is notified of a hot lead and takes over the conversation. Updates the deal outcome. |
| **Partner** | A certified installer or studio | Receives routed car-owner leads and reports the outcome. |
| **Self-serve customer** | A business on the self-serve tier | Signs up, connects accounts, answers the questionnaire and approves its own work. |
| **Managed customer** | A business on the managed tier | Same product, with the platform owner overseeing the account. |

## 6. Product tiers

| Tier | What the customer does | What the platform owner does |
|---|---|---|
| **Self-serve** | Signs up, pays a subscription, connects accounts, approves its own work | Nothing routine |
| **Managed** | Supplies details and approves work | Oversees the account and its results |

Pricing, plan limits and what exactly distinguishes the managed tier are open questions.

## 7. The agent team

One agent per role in the agency structure supplied by the owner. "Approval" names who must approve the agent's output before it has an effect outside the product.

### 7.1 Leadership

| # | Agent | Responsibility | Output | Approval |
|---|---|---|---|---|
| 1 | **Agency Head** | Orchestrates all other agents for a brand. Turns the approved strategy into work, assigns it, tracks it, escalates problems. | Work plan, status, escalations | Reports to approver; does not publish anything itself |

### 7.2 Strategy and research

| # | Agent | Responsibility | Output | Approval |
|---|---|---|---|---|
| 2 | **Marketing and Brand Strategist** | Positioning, audiences, content themes, channel plan, 90-day goals | Strategy brief | Approver signs off the brief |
| 3 | **Market Research / Consumer Insights** | Onboarding research on the brand, competitors, audience and visibility; builds the tailored questionnaire | Research findings, questionnaire, draft brand profile | Approver confirms facts |

### 7.3 Creative and content

| # | Agent | Responsibility | Output | Approval |
|---|---|---|---|---|
| 4 | **Creative Director** | Campaign concepts; reviews all creative for quality and brand fit before it reaches the approver | Concepts, creative review verdicts | Internal gate before approval |
| 5 | **Art Director / Senior Designer** | Visual direction and templates per brand | Brand visual system, templates | Approver signs off the visual system once |
| 6 | **Graphic Designer** | Posts, carousels, ad creatives, thumbnails | Finished graphics | Per item |
| 7 | **Copywriter / Content Manager** | Articles, captions, ad copy, emails, landing-page copy | Finished copy | Per item |
| 8 | **Photographer** | Selects, edits and repurposes uploaded photos; generates AI images to fill gaps; writes shot lists | Edited images, shot lists | Per item |
| 9 | **Videographer / Video Editor** | Edits uploaded footage into reels, shorts and ads; AI video to fill gaps | Finished videos | Per item |
| 10 | **Animator / Motion Graphics** | Animated explainers, motion titles, logo stings | Motion assets | Per item |

### 7.4 Digital marketing and distribution

| # | Agent | Responsibility | Output | Approval |
|---|---|---|---|---|
| 11 | **Performance Marketing** | Google, Meta and LinkedIn ads: planning, launch, adjustment, pausing, reporting | Campaigns, spend reports | Approver approves each campaign and its budget cap; agent acts alone inside the cap |
| 12 | **Social Media Manager** | Content calendar, scheduling and publishing on each channel | Calendar, published posts | Per item or per calendar |
| 13 | **SEO Specialist** | Site audit, keyword research, on-page recommendations, AI-answer (GEO) tracking | Audit, content briefs, recommendations | Recommendations approved before action |
| 14 | **Email Marketing / CRM** | Lead follow-up sequences, newsletters, lead records and pipeline hygiene | Sequences, sends, clean pipeline | Sequences approved once, then run automatically |
| 15 | **Influencer and Community** | Replies to comments and messages; influencer discovery and outreach drafts | Replies, outreach drafts | Routine replies automatic from approved answers; anything unusual or negative goes to the approver; outreach is approved before sending |

### 7.5 Web and marketing technology

| # | Agent | Responsibility | Output | Approval |
|---|---|---|---|---|
| 16 | **UI/UX Designer** | Designs campaign landing pages; recommends changes to the main site | Page designs, recommendations | Per page |
| 17 | **Web Developer** | Builds and publishes landing pages hosted by the product | Live landing pages | Per page |
| 18 | **Marketing Automation / Technical** | Connects the brand's accounts, keeps integrations healthy, sets up tracking | Working connections, alerts | None for upkeep; new connections need the brand's authorisation |

### 7.6 Analytics and optimisation

| # | Agent | Responsibility | Output | Approval |
|---|---|---|---|---|
| 19 | **Marketing Data Analyst** | Results against targets, attribution from content to lead to sale, weekly and monthly reports | Reports, insights | None; informational |
| 20 | **Tracking and CRO** | Tracking setup and checks; tests on landing pages and creatives | Test plans, results, winners | Tests on live pages approved before launch |

### 7.7 Finance, administration and legal

| # | Agent | Responsibility | Output | Approval |
|---|---|---|---|---|
| 21 | **Finance / Administration** | Subscription billing for customers; ad spend and tool cost tracking per brand against approved budgets | Invoices, budget reports, overspend alerts | Platform owner |
| 22 | **Legal and Contracts** | Checks content and ads for risky claims, copyright and required disclosures; fills client agreements from approved templates and tracks signatures | Compliance verdicts, contracts | Compliance check is a gate before approval; contract templates need a human lawyer's sign-off once |

## 8. Core workflows

### 8.1 Onboarding

1. The customer supplies the website, social links and any brochures or decks.
2. The research agent studies what is public: the site, each social profile, search and AI-answer visibility, competitors, reviews and listings.
3. It drafts a brand profile and marks each item found, assumed or unknown.
4. It generates a tailored questionnaire that asks only what research could not settle, with guesses pre-filled for confirmation.
5. The customer answers on the dashboard; answers can be saved and resumed.
6. The strategist produces the brand profile, the verified-facts list and the strategy brief.
7. The approver signs these off. Nothing else runs before this.

### 8.2 Content production

1. The strategist's plan becomes briefs: angle, format, channel, call to action.
2. Copy and visuals are produced in two or three variants per piece.
3. The Creative Director agent reviews for quality and brand fit and picks the strongest.
4. The Legal agent checks claims, copyright and disclosures. Every factual claim must be in the verified-facts list.
5. The item goes to the approval inbox with the winner and the alternatives.
6. Approved items are scheduled and published. Rejections with comments go back for one revision cycle at a time, up to a limit, then escalate.

### 8.3 Campaigns

Each campaign records its objective (brand awareness, leads or conversion), audience, channels, budget, target numbers and dates. The dashboard shows results against targets. Paid campaigns need an approved budget cap before launch.

### 8.4 Leads and the sales cycle

1. Leads are captured from landing pages, site forms, social lead forms, comments and messages.
2. Each lead is recorded with its source, so content can be tied to leads and sales.
3. The agent qualifies the lead by chat or email.
4. A hot lead follows the route set for its type: the agent books a call or appointment, a named salesperson is notified and takes over, or a car-owner lead is routed to the nearest partner.
5. The pipeline tracks each deal through its stages to won or lost, including outcomes reported by partners.

Aztek lead types: car owners, installers and studios wanting to become partners, and distributors abroad.

### 8.5 Reporting

Weekly and monthly reports per brand: output, reach, leads, pipeline, spend, results against targets, and what the agents will change next.

## 9. Approvals and autonomy

| Action | Rule |
|---|---|
| Brand profile, verified facts, strategy brief | Approver signs off |
| Each article, post, creative, video, email, landing page | Approver signs off before it goes live |
| Follow-up sequences | Approved once, then run automatically |
| Routine replies to comments and messages | Automatic, from approved answers only |
| Unusual or negative comments and messages | Approver |
| Paid campaign and its budget cap | Approver |
| Launching, adjusting and pausing ads inside the cap | Agent, no approval |
| Exceeding a cap | Never; the agent stops and asks |
| Main website changes | Never by agents; recommendations only |
| Contracts | From lawyer-approved templates; sent after platform-owner approval |

For Aztek and 11oils the approver is the platform owner. For outside clients it is the client's named brand approver, who is notified and reviews in the dashboard.

## 10. Dashboard (marketing.sarathi.gvcc.in)

| Section | Shows |
|---|---|
| **Home** | Pending approvals, running work, failures, health per brand |
| **Approval inbox** | Each item with a full preview and alternatives; approve, reject or comment |
| **Agents** | What each agent is doing, has finished, or is blocked on |
| **Brand view** | Search and AI-answer trends, content calendar, campaigns against targets, lead funnel, sales pipeline |
| **Leads and pipeline** | Every lead, its source, stage, owner and outcome |
| **Reports** | Weekly and monthly, downloadable |
| **Settings** | Brand profile, verified facts, users, connected accounts, budgets, kill switch |

## 11. Requirements

**P0** is needed to prove the product on Aztek. **P1** follows once P0 is working. **P2** is needed to sell to outside clients; the design must allow for it from the start.

### 11.1 P0 — Aztek pilot

| ID | Requirement | Acceptance criteria |
|---|---|---|
| P0-1 | Tenant-aware data from day one | Every record belongs to one brand. A user with access to brand A cannot read or change brand B's data through any screen or API. |
| P0-2 | Roles and sign-in | Platform owner and brand approver roles exist. A brand approver sees only their brand. |
| P0-3 | Onboarding research and questionnaire | Given a website and social links, the product produces a draft profile with each item marked found, assumed or unknown, and a questionnaire that omits anything already confirmed. |
| P0-4 | Verified-facts list | No research finding is treated as fact until confirmed. A draft containing a factual claim not on the list is blocked before it reaches the approver. |
| P0-5 | Strategy brief | After the questionnaire, a brief with positioning, audiences, themes, channel plan and 90-day goals is produced and must be approved before any content work starts. |
| P0-6 | Agent orchestration | Each of the 22 roles exists as a named agent with a defined input and output. The Agents screen shows each one's current state. |
| P0-7 | Content production with variants | Each piece is produced in at least two variants, passes creative review and the compliance check, and arrives in the inbox with the chosen version and alternatives. |
| P0-8 | Real-asset library | The brand can upload photos and footage. Visual agents use them and label any AI-generated element. |
| P0-9 | Approval inbox | Approve, reject or comment on any item with a full preview. A rejection with a comment triggers a revision. A notification is sent when an item is waiting. |
| P0-10 | Publishing to Instagram, Facebook, LinkedIn and YouTube | An approved item is published at its scheduled time on the chosen channels. A failed publish is retried, then reported; it is never dropped silently. |
| P0-11 | SEO and GEO | Site audit, keyword research, content briefs, and weekly tracking of search performance and AI-answer mentions. Articles are delivered to the site as drafts, never published by the agent. |
| P0-12 | Lead capture with source | Every lead records the channel and the content or campaign that produced it. |
| P0-13 | Built-in pipeline | Leads move through stages to won or lost. Each lead type has its own route. |
| P0-14 | Qualification and booking | The agent qualifies a lead by chat or email and can book a call or appointment. A hot lead notifies the named salesperson. |
| P0-15 | Partner routing | A car-owner lead is passed to the nearest partner, and the outcome is recorded. |
| P0-16 | Routine replies | Common questions on comments and messages are answered from approved answers. Anything unusual or negative is held for the approver. |
| P0-17 | Reporting and attribution | A weekly report shows output, leads, pipeline and results against targets, and ties content to leads and sales. |
| P0-18 | Kill switch and audit log | One action stops all outgoing activity for a brand. Every agent action and approval is logged with time and actor. |
| P0-19 | English only | All generated content is in English. |
| P0-20 | Automatic link tagging | Every link the product publishes carries the tags in section 13.3. No tag is typed by hand. |
| P0-21 | Cost ledger per tenant | Every agent run records its AI usage against a brand. A run or a tenant that reaches its cost ceiling stops and reports. |
| P0-22 | Evaluation gate | A change to a prompt, model or agent cannot go live unless the brand's evaluation set passes. Changes are versioned and reversible. |
| P0-23 | Partner outcome recording | A partner can report won or lost, value and date through a single-purpose link. Unreported leads are marked "outcome unknown", never lost. |
| P0-24 | Staged rollback | Activity can be paused for one agent, one channel or a whole brand. Scheduled items are held, not deleted. |
| P0-25 | Shadow mode | A brand can run with all content produced into the inbox and nothing published. |

All requirements in section 15 (AI governance) and section 16 (security, privacy and reliability) are also P0 unless marked otherwise there.

### 11.2 P1 — after the pilot is working

| ID | Requirement | Acceptance criteria |
|---|---|---|
| P1-1 | Paid ads with capped autonomy | The agent launches, adjusts and pauses Google, Meta and LinkedIn ads inside an approved cap, and cannot exceed it. |
| P1-2 | Landing pages | Agents design, build and publish campaign landing pages on the product's hosting after approval. |
| P1-3 | Tests on pages and creatives | A test is proposed, approved, run, and the winner is reported. |
| P1-4 | Email sequences and newsletters | Sequences are approved once and then run; unsubscribes are honoured automatically. |
| P1-5 | Influencer discovery and outreach drafts | Candidates and outreach drafts are produced; nothing is sent without approval. |
| P1-6 | Budget and cost tracking | Ad spend and tool cost per brand are shown against approved budgets, with an alert before a cap is reached. |
| P1-7 | Second brand | 11oils is onboarded as a tenant with no code change. |

### 11.3 P2 — selling it

| ID | Requirement | Acceptance criteria |
|---|---|---|
| P2-1 | Self-serve sign-up | A business can sign up, connect accounts and complete onboarding without the platform owner. |
| P2-2 | Subscription billing | Invoices, payment collection and renewals run automatically. |
| P2-3 | Client contracts | Agreements are generated from approved templates and signatures are tracked. |
| P2-4 | Managed tier | The platform owner can oversee a managed customer's account. |
| P2-5 | Sync to a customer's own CRM | Leads and stages sync to an outside CRM when the customer has one. |
| P2-6 | Client approver notifications | The client's named approver is notified and approves in their own view. |

## 12. Guardrails

A summary. The full requirements are in sections 14 to 16. The verified-facts list covers factual claims only; section 15 covers the other ways AI output can fail.

- **No invented facts.** Claims come only from the verified-facts list.
- **Nothing customer-facing without an approval or a pre-approved rule.**
- **Budget caps are hard limits.**
- **Tenant isolation.** No brand can see another's data.
- **Official platform routes only.** No scraping or unofficial automation that risks an account ban.
- **Lead data handling.** Consent and retention rules follow India's data protection law; details are an open question for legal review.
- **Volume caps** on email and messaging to protect sending reputation.
- **AI-generated visuals are labelled** inside the product so the approver knows what is real.

## 13. Measurement, attribution and unit economics

### 13.1 Rules that apply to every metric

- **Every metric has a definition, a source, a measurement window and a target rule.** They are listed in 13.2.
- **No target is invented in this document.** Where a target depends on a figure the owner has not supplied, the table says how the target will be derived once the figure exists.
- **Baselines are captured before the pilot goes live**, over one fixed baseline period, from the current team's actual results. The length of that period is a proposed default (section 21).
- **The product measures itself.** Approval time, revisions, failures and costs are recorded by the product, not estimated by a person.
- **Each number is reported per brand, and per lead type where it applies**, because car owners, partner applicants and distributors convert at different speeds.

### 13.2 Metric catalogue

**Outcomes**

| Metric | Definition | Window | Target rule |
|---|---|---|---|
| Qualified leads | Leads that meet the brand's qualification definition (open question 16) | Monthly | At least the baseline average |
| Lead-to-opportunity conversion | Opportunities created divided by qualified leads, by lead type | Monthly cohort | At least baseline; baseline needed |
| Opportunity-to-sale conversion | Deals won divided by opportunities, by lead type | Cohort, closed within the lead type's lookback | At least baseline; baseline needed |
| Pipeline influenced | Value of open opportunities with at least one attributed touch | Monthly | Set after first full month |
| Revenue influenced | Value of won deals with at least one attributed touch | Monthly and quarterly | Set after first full quarter; needs deal values (open question 17) |
| Content published | Items published, by format and channel | Monthly | At least the baseline average |
| Organic search clicks and impressions | From Search Console | Monthly | Growth over the figure recorded at go-live |
| AI-answer mention rate | Share of a fixed prompt set in which the brand is mentioned | Weekly, reported as a four-week average | Growth over the figure recorded at go-live |

**Cost and return**

| Metric | Definition | Window | Target rule |
|---|---|---|---|
| Cost per content item | AI and tool cost charged to the brand's content work, divided by items published | Monthly | Below the current team's cost per item; baseline needed |
| Cost per qualified lead | Ad spend plus AI and tool cost for the brand, divided by qualified leads. Reported with and without ad spend. | Monthly | Below baseline; baseline needed |
| Paid-media return | Attributed revenue divided by ad spend. Where revenue is not recorded, cost per qualified lead from paid channels is shown instead. | Per campaign and monthly | Set per campaign at approval |
| AI and tool cost per tenant | Metered AI usage plus the tenant's share of tool subscriptions | Monthly | Within the plan's cost allowance (needs pricing) |
| Gross margin per plan | Plan revenue minus AI, tool and hosting cost per tenant, divided by plan revenue | Monthly | Needs pricing (open question 11) |

**Operations and human effort**

| Metric | Definition | Window | Target rule |
|---|---|---|---|
| Approval turnaround time | Time from an item entering the inbox to a decision. Median and 90th percentile. | Weekly | Set after the first month of data |
| Owner approval time | Time the owner spends in the inbox, recorded by the product | Daily | Within the owner's stated budget (open question 3) |
| Human intervention rate | Share of items needing any human action beyond one approve click: an edit, a rejection, a manual fix or a takeover | Weekly | Falling trend; threshold set after the first month |
| Average revision count | Revisions per item before approval | Weekly | Falling trend; threshold set after the first month |
| First-pass approval rate | Share of items approved with no edit and no revision | Weekly | Rising trend; threshold set after the first month |
| Failed publication rate | Scheduled publishes that failed after all retries, divided by scheduled publishes | Weekly | Below the rollback threshold in section 14 |
| Staff hands-on hours | Hours marketing staff spend doing work the product should do | Monthly | Zero at pilot success |

**Quality and safety**

| Metric | Definition | Window | Target rule |
|---|---|---|---|
| Incorrect-claim rate | Published items later found to contain a wrong claim or a claim not on the verified-facts list, divided by items published | Monthly | Zero |
| Claims caught before approval | Drafts blocked by the fact check | Weekly | Reported, no target; a leading indicator of drafting quality |
| Spend above an approved cap | Any amount | Continuous | Zero |

**Email**

| Metric | Definition | Window | Target rule |
|---|---|---|---|
| Delivery rate | Delivered divided by sent | Per send and monthly | Set after first sends |
| Unsubscribe rate | Unsubscribes divided by delivered | Per send and monthly | Set after first sends |
| Complaint rate | Spam complaints divided by delivered | Per send and monthly | Below the proposed limit in section 21; sending pauses automatically if breached |

### 13.3 Attribution model

The values below marked "proposed" are recommendations awaiting the owner's confirmation (section 21). The real sales-cycle length for each lead type is an open question and decides the lookback windows.

- **Touch.** A recorded interaction with a known source: a tagged link click, a platform lead form, a comment or message on a specific post, or an email click.
- **Lead credit (proposed).** A lead is credited to the last non-direct touch before it was created. The first touch is also stored and reported.
- **Influence.** Any touch inside the lookback window counts toward "pipeline influenced" and "revenue influenced".
- **Lookback windows (proposed).** 30 days from touch to lead. From lead to sale: 90 days for car owners, 180 days for partner applicants and distributors.
- **Channel priority (proposed).** When two touches cannot be ordered, credit goes in this order: paid ad, email, organic social, organic search, referral, direct.
- **Sources without a link.** Platform lead forms carry the campaign and ad identifiers. Comments and messages carry the post identifier. Phone and walk-in leads record a "how did you hear about us" answer and are reported separately as self-reported.
- **Identity.** A person is matched across touches by phone number or email.

**Link tagging convention (proposed).** The product generates every tag; nobody types them by hand. All lowercase, words joined by hyphens.

| Tag | Value |
|---|---|
| `utm_source` | The platform: `instagram`, `facebook`, `linkedin`, `youtube`, `google`, `email` |
| `utm_medium` | `organic-social`, `paid-social`, `cpc`, `email` or `referral` |
| `utm_campaign` | Brand, objective, month and name, for example `aztek-leads-202610-ppf-monsoon` |
| `utm_content` | The content item's ID in the product |
| `utm_term` | The keyword or ad set, for paid only |

**Offline partner sales.**

1. A routed lead keeps its ID and its attribution when it goes to a partner.
2. The partner reports the outcome (won or lost, value, date) through a single-purpose link. No account is needed.
3. Reminders are sent at set intervals (proposed in section 21).
4. A lead with no report after the final reminder is marked "outcome unknown". It is never counted as lost.
5. The brand's sales contact can enter or correct an outcome.
6. For Aztek, a warranty registration that matches the lead's phone number could confirm a sale without relying on the partner. Whether this is usable is open question 26.

### 13.4 Unit economics

- **A cost ledger per tenant.** Every agent run records its AI usage against the brand. Tool subscriptions are shared out across tenants. Ad spend is recorded separately as money passed through to the platforms.
- **Cost limits.** Each run, and each tenant per day, has a cost ceiling. An agent that reaches it stops and reports.
- **Margin per plan** is calculated monthly once pricing exists, and decides plan limits.

## 14. Pilot scope, launch gates and rollback criteria

### 14.1 Pilot scope

| In the pilot | Not in the pilot |
|---|---|
| One brand: Aztek | 11oils and outside clients |
| Instagram, Facebook, LinkedIn, YouTube | Any other channel |
| English | Other languages |
| Car owners, partner applicants, distributors abroad | Other lead types |
| Everything in P0 | Paid ads, landing pages, tests, email newsletters, influencer work (P1) |
| Organic content and lead handling | Self-serve sign-up, billing, contracts (P2) |

The pilot's measured period and whether the current team keeps working alongside it are open question 19. The recommendation is a parallel run: the team is not redirected until gate 5 passes.

### 14.2 Launch gates

Each gate must pass before the next stage starts. The platform owner signs off each one.

| Gate | Stage it opens | Must be true |
|---|---|---|
| **0** | Onboarding Aztek | Tenant isolation tested. Audit log working. Kill switch tested. A backup has been restored successfully. |
| **1** | Content work | Brand profile, verified-facts list and strategy brief approved. |
| **2** | Shadow mode ends | Agents have produced content into the inbox for the agreed period with nothing published. The evaluation set in section 15 passes and confidence thresholds are set. No unverified claim got past the fact check. |
| **3** | Limited live | One channel at low frequency. Publishing works end to end. Failed publication rate is under the threshold. Account connections are healthy. |
| **4** | Full pilot | All four channels and lead handling live. Leads are captured with a source, and each lead type reaches its route. |
| **5** | Pilot success | Section 13 targets met for the agreed consecutive period. Staff can be redirected. |

### 14.3 Rollback criteria

Rollback never deletes anything. Scheduled items are held, not lost. It can be applied to one agent, one channel or a whole brand.

| Trigger | Action |
|---|---|
| Any published item contains an incorrect or unverified claim | Pause publishing for the brand. Correct or remove the item. Find the cause before resuming. |
| A platform warns or restricts an account | Stop all activity on that platform until the cause is understood. |
| One brand's data is visible to another | Stop all activity across the whole platform. Highest severity. |
| Spend goes above an approved cap | Pause all ads for the brand. |
| Failed publication rate above the threshold for a week | Hand publishing back to people for that channel. |
| Email complaint rate above the limit | Pause all sending. |
| A lead gets no response, or the wrong response | Hand lead handling back to people until fixed. |
| Qualified leads below baseline by the agreed margin for the agreed period | Hand lead generation back to the team and review. |

The numeric thresholds are proposed in section 21.

## 15. AI governance

Every requirement in this section is P0 unless it is marked otherwise.

### 15.1 What can go wrong, and which control answers it

The verified-facts list stops invented facts. It does not stop the other ways an AI system can fail, so each failure type has its own control.

| Failure type | Example | Control |
|---|---|---|
| Invented or wrong fact | A made-up statistic or certification | Verified-facts check and claim-to-source traceability (AI-5) |
| Unsafe recommendation | Care or installation advice that could damage a vehicle or injure someone | Unsafe-advice check (AI-10) |
| Tone failure | Off-brand, insensitive or badly timed content | Brand safety rules and tone check (AI-8) |
| Policy violation | Content that breaks a platform's rules or advertising standards | Platform and advertising policy check (AI-9) |
| Harmful content | Hateful, abusive or sexual material, outgoing or incoming | Content moderation (AI-7) |
| Manipulated source material | A web page, review or uploaded file that is false or planted | Source handling rules (AI-11) |
| Hijacked agent | A comment or page that tells the agent to do something | Prompt-injection protection (AI-6) |
| Silent quality drop | A model update makes output worse | Versioning and regression testing (AI-1 to AI-3) |

### 15.2 Versioning, evaluation and release

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AI-1 | Model and prompt versioning | Each agent's prompt, model, settings and tools are versioned. Every output records the versions that produced it. Model versions are pinned, so a provider cannot change behaviour unnoticed. The previous version is always kept. |
| AI-2 | Evaluation datasets | Each brand has an evaluation set, and the platform has a shared one. Each holds owner-approved good examples and bad cases for every failure type in 15.1. Every incident that reaches the public adds a new case. |
| AI-3 | Regression testing | Any change to a prompt, model, tool or provider version runs the full evaluation set. The change is blocked if the pass mark is missed or if any safety case fails. The platform owner releases the change. |
| AI-4 | Confidence thresholds | Each automated check and each automated decision produces a score. Below the threshold, the item is not handled automatically: it goes to a person with the reason shown. This applies to content checks, automatic replies and lead qualification. Thresholds are set at gate 2 from evaluation results, not assumed here. |

### 15.3 Truth and sources

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AI-5 | Claim-to-source traceability | Every factual claim in an item links to its verified-fact record: source, who confirmed it, and when. The approver sees these links in the preview. When a fact changes or expires, the product lists every live item that uses it. |
| AI-11 | Source handling | Every research finding records its source and date. A finding from a single source is marked assumed, not found. Conflicting sources are flagged. Content from competitors, reviews and third parties never becomes a fact. Uploaded assets record who supplied them and the right to use them. |

### 15.4 Safety checks on content

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AI-7 | Content moderation | All outgoing content and all incoming public messages are screened for hateful, abusive, sexual, violent and illegal material. Outgoing content that fails is blocked. Incoming abuse is flagged and handled by the brand's rule. |
| AI-8 | Brand safety rules | Each brand has a rulebook: forbidden topics and claims, competitors not to be named, tone limits, and dates or events when posting pauses. A tone check runs on every item, separately from the fact check. |
| AI-9 | Platform and advertising policy check | Each item is checked against the rules of the platform it is going to and the advertising standards of the brand's market. An item that fails is blocked with the rule named. |
| AI-10 | Unsafe-advice check | Any instruction that could cause damage, injury or loss must come from guidance on the verified-facts list. Otherwise it is blocked. In lead chats and public replies, agents give no technical or safety advice beyond approved answers. |
| AI-18 | Maker and checker are separate | No agent approves its own work. Each check is a separate step from the step that produced the item. |
| AI-19 | Quality scoring | Each content type has a scoring guide covering accuracy, brand voice, clarity, originality, platform fit, call to action and visual quality. The Creative Director agent scores each item, and its scores are compared with the approver's decisions. |

### 15.5 Prompt-injection protection

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AI-6 | Untrusted content is data, never an instruction | Web pages, comments, messages, emails, form entries, reviews and uploaded files are marked untrusted. An agent that reads untrusted content cannot publish, spend, send or reach credentials on its own; anything it proposes passes through the normal checks and approval. The evaluation set includes injection attempts, and all of them must fail. |

### 15.6 Human escalation

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AI-12 | Escalation triggers | An item or conversation goes to a person when any trigger below fires. Each escalation carries its context, has a named owner and a time limit, and is visible on the dashboard. |

Triggers:

- A score below its confidence threshold.
- A check still failing after the revision limit.
- A complaint, anger, a legal threat, a safety issue, or a request to speak to a person.
- A message from the press, a regulator, a lawyer or an influencer.
- A question about price, discount or terms beyond approved answers.
- A sudden rise in negative comments on a brand.
- Any content about a named individual.
- A cost ceiling reached.
- The same step failing repeatedly.

### 15.7 Failure, cost and data

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AI-13 | Model failure and provider outage | A malformed or empty output is retried, then marked for manual handling. During a provider outage, work is queued and held, never dropped and never half-published. A fallback provider may be used only for an agent whose evaluation set has passed on that provider (P1). Lead response has a fallback: a holding message and a notification to a person. |
| AI-14 | Cost limits | There is a cost ceiling per run, per type of deliverable, and per brand per day and per month. Reaching one stops the work and reports it. An agent is never switched to a weaker model to save cost without passing the evaluation set. Ceiling values are set from the first month's data. |
| AI-15 | Customer-data use and training restrictions | A customer's data is used only for that customer's work. It is never used to train or tune any model, ours or a provider's. One brand's content, leads and results never inform another brand's output. Each provider's terms are checked and recorded before use. Personal data is kept out of prompts unless the task needs it. |

### 15.8 Provenance and rollback

| ID | Requirement | Acceptance criteria |
|---|---|---|
| AI-16 | Provenance of AI-generated content | Each item records the agents and versions that made it, the source assets and whether each is real or generated, the facts used, the checks passed and who approved it. Generated visuals are labelled inside the product and disclosed publicly wherever a platform or the law requires. Embedding provenance data in the files themselves is P1. |
| AI-17 | Rollback procedures | A prompt or model can be returned to its previous version in one action. A live item can be corrected or taken down, and the product lists every other item made by the same version or using the same fact. Any agent can be paused alone. Every rollback creates an incident record and a new evaluation case. |
| AI-20 | Monitoring | Automatic replies are sampled for review each week. Incorrect-claim rate, intervention rate and revision count are tracked, with an alert when any worsens. |

Whether automated replies must say they are automated is open question 22.

## 16. Security, privacy and reliability requirements

Every requirement in this section is P0 unless it is marked otherwise. Figures marked "section 21" are recommended defaults awaiting confirmation.

### 16.1 Access

| ID | Requirement | Acceptance criteria |
|---|---|---|
| SEC-1 | Multi-factor sign-in | Required for every person who can approve, publish, spend, see lead data or administer. There is no way to turn it off for a single user. |
| SEC-2 | Role-based access | Permissions follow the table below. Every permission is enforced on the server, not only hidden on screen. Sign-ins and permission changes are logged. |
| SEC-3 | Agent permissions | Each agent has only the abilities its role needs. A research agent cannot publish; a writing agent cannot spend. |

| Permission | Platform owner | Brand admin | Brand approver | Sales contact | Viewer | Partner |
|---|---|---|---|---|---|---|
| See other brands | Yes | No | No | No | No | No |
| View brand content and reports | Yes | Yes | Yes | No | Yes | No |
| Edit profile and verified facts | Yes | Yes | No | No | No | No |
| Approve content | Yes | Yes | Yes | No | No | No |
| Approve budgets | Yes | Yes | No | No | No | No |
| Connect or disconnect accounts | Yes | Yes | No | No | No | No |
| Manage users | Yes | Yes | No | No | No | No |
| View lead personal data | Yes | Yes | No | Own leads | No | Routed lead only |
| Export or delete data | Yes | Yes | No | No | No | No |
| Use the kill switch | Yes | Yes | No | No | No | No |

Brand admin is the main user of a self-serve or managed customer (section 5). Viewer is a read-only user a brand can add. The partner has no account; access is through a single-purpose link.

### 16.2 Credentials, encryption and secrets

| ID | Requirement | Acceptance criteria |
|---|---|---|
| SEC-4 | Connected-account credentials | Access tokens are stored encrypted, are never sent to the browser, and never appear in logs or in prompts. Agents never see a raw token; calls go through a connection service. Each connection asks for the least permission needed. Tokens are refreshed automatically, and a warning is raised before one expires. |
| SEC-5 | Encryption | Data is encrypted in transit and at rest, including the database, backups and uploaded assets. |
| SEC-6 | Secrets management | API keys and passwords live in a secrets store, never in code, workflow settings or exports. Keys are rotated on a schedule and at once after any suspected exposure. Each environment has its own keys. |
| SEC-7 | Security testing | Dependencies are kept up to date. An independent security test is done before the product is sold to outside customers (P2). |

### 16.3 Audit log

| ID | Requirement | Acceptance criteria |
|---|---|---|
| SEC-8 | Audit log | Every agent action, approval, sign-in, settings change, data export and deletion is recorded with who, what, when and which brand. Entries cannot be changed or removed. Reading the log is itself logged. The log can be exported per brand. Retention period: section 21. |

### 16.4 Privacy and data rights

| ID | Requirement | Acceptance criteria |
|---|---|---|
| PRIV-1 | Purpose and consent | Lead data is collected for a stated purpose. Consent is recorded with its source and time. |
| PRIV-2 | Data export | A customer can export all of its data in a common format: content, assets, leads, pipeline, reports and verified facts. |
| PRIV-3 | Data deletion | One person's data can be deleted on request, across the main store and connected tools, and ages out of backups. A whole tenant is deleted at offboarding after the retention period, and the customer gets confirmation. Time limit: section 21. |
| PRIV-4 | Retention | Lead data is deleted after a set period. The period is open question 23. |
| PRIV-5 | Opt-outs | An opt-out is honoured on every channel, not only the one where it was made. |
| PRIV-6 | Data sent to AI providers | Only what the task needs. No training on it (AI-15). |
| PRIV-7 | Handling | Personal data is never copied to a personal machine. |

India's data protection law applies. Leads from distributors abroad may bring other countries' laws into play. Both are for legal review (open questions 13 and 24).

### 16.5 Backups and disaster recovery

| ID | Requirement | Acceptance criteria |
|---|---|---|
| REL-1 | Backups | Taken daily, encrypted, with a copy kept away from the main server. A restore is tested on a schedule. Retention and schedule: section 21. |
| REL-2 | Disaster recovery | A written procedure rebuilds the product on a new server from backups. It is rehearsed. Maximum data loss and maximum time to recover: section 21. |

### 16.6 Monitoring and alerts

| ID | Requirement | Acceptance criteria |
|---|---|---|
| REL-3 | Monitoring | The product watches: availability, failed runs, work waiting too long, tokens about to expire, cost spikes, platform errors, publishing delays and lead response time. |
| REL-4 | Alerts | Each alert goes to a named person with enough detail to act. A missing heartbeat raises an alert, so a monitor that has stopped is noticed. No failure is silent. |

### 16.7 Retries, duplicates and rate limits

| ID | Requirement | Acceptance criteria |
|---|---|---|
| REL-5 | Retries | Temporary failures are retried a limited number of times with increasing waits. Permanent failures are not retried; they are reported. |
| REL-6 | Duplicate protection | Each outgoing action carries a unique key. Before a retry, the product checks whether the action already happened. This covers posts, emails, messages, ad launches, lead creation and payments. The same post is never published twice; the same lead is never created twice. |
| REL-7 | Rate limits | Usage is tracked per platform and per connected account. The product slows down when a platform signals a limit and spreads scheduled work to stay inside it. Limits are never worked around. One brand's activity cannot use up another's allowance. |
| REL-8 | Durable runs | A run paused for approval survives restarts and resumes where it stopped. If a platform or tool is down, items wait and resume. |

### 16.8 Account disconnection

| ID | Requirement | Acceptance criteria |
|---|---|---|
| REL-9 | Lost connection | The product detects a revoked or expired token, a changed password or a lost permission. Affected work pauses, items are held, and the brand is told how to reconnect. Nothing is lost. Work resumes after reconnection. |
| REL-10 | Disconnection by the customer | Takes effect at once. The token is revoked and deleted. Scheduled items for that account are held. |

### 16.9 Incident response

| ID | Requirement | Acceptance criteria |
|---|---|---|
| REL-11 | Incident process | Every incident has a severity, an owner, a record and a review. The review adds an evaluation case or a test so the same failure is caught next time. Customers are told about incidents that affect their data, within the time the law requires (legal review). |

| Severity | Examples | First action |
|---|---|---|
| **1** | One brand's data visible to another. Unapproved publishing or spending. Leaked credentials. | Stop all activity on the platform. Notify the owner at once. |
| **2** | Publishing or lead response down for a brand. An incorrect claim live. An account restricted. | Pause the affected function for the brand. Notify the approver. |
| **3** | A degraded function, a delayed report, a failing integration with a workaround. | Log and fix in normal order. |

Response times: section 21. With no staff, the platform owner is the only responder. Who covers when the owner is unavailable is open question 28.

### 16.10 Availability and recovery targets

| ID | Requirement | Acceptance criteria |
|---|---|---|
| REL-12 | Targets | The product meets the availability, publishing timeliness, data-loss and recovery figures in section 21, and reports against them monthly. |
| REL-13 | Shared server | The existing workflows on the n8n server are not changed and do not lose resources to this product. |

## 17. Agency operating model and client lifecycle

### 17.1 Who does what with no staff

| Function | Done by | Human involvement |
|---|---|---|
| Strategy, research, content, campaigns, reporting | The 22 agents | Approvals only |
| Coordination and chasing | Agency Head agent | None |
| Approvals | Platform owner for own brands; the client's approver for outside clients | Yes |
| Hot-lead conversations | Brand sales contact or partner | Yes |
| Billing and contracts | Finance and Legal agents | Owner approves contracts; a lawyer approves templates once |
| Support for customers of the product | Not covered by the 22 roles (open question 20) | To be decided |
| Selling the product to new customers | Not covered by the 22 roles (open question 21) | To be decided |

### 17.2 Operating rhythm

| Frequency | What happens |
|---|---|
| Daily | Publishing, public replies, lead handling, approvals |
| Weekly | Report, next week's calendar for approval, reply sample review |
| Monthly | Performance review, next month's plan, invoice, cost and margin review |
| Quarterly | Strategy refresh, questionnaire refresh, verified-facts review |

**Escalation path:** agent, then Agency Head agent, then the brand's approver, then the platform owner.

### 17.3 Client lifecycle

| Stage | What happens | Ends when |
|---|---|---|
| **Sign-up** | The customer chooses a tier | Account created |
| **Contract and payment** | Agreement signed, first payment taken | Both complete |
| **Connect accounts** | The customer authorises its social, search and analytics accounts | All launch channels connected and healthy |
| **Onboarding** | Research, questionnaire, profile, verified facts | Customer confirms the facts |
| **Strategy** | Strategy brief produced | Approver signs it off |
| **Shadow period** | Content is produced into the inbox; nothing is published | Quality pass marks met |
| **Go live** | Channels are switched on in stages | All agreed channels live |
| **Steady state** | The operating rhythm in 17.2 | Ongoing |
| **Review and renewal** | Results against targets; plan and budget for the next term | Renewed or ended |
| **Change** | Add a channel, change a budget, change plan | Change approved and applied |
| **Pause** | Customer request or non-payment after a grace period; all outgoing activity stops | Resumed or ended |
| **Offboarding** | Activity stops, account connections are revoked, the customer's data is exported to them, then deleted after the retention period; final invoice | Deletion confirmed |

Who owns content and assets after offboarding is open question 25. Service commitments to customers depend on pricing and are part of open question 11.

## 18. Release phasing

No dates are given because the deadline is an open question.

1. **Foundation.** Tenants, roles, dashboard shell, approval inbox, audit log, kill switch.
2. **Onboarding and strategy.** Research, questionnaire, verified facts, strategy brief, run on Aztek.
3. **Content and organic.** Creative agents, compliance check, SEO and GEO, publishing to four channels.
4. **Leads and sales.** Capture, qualification, booking, salesperson handoff, partner routing, pipeline, routine replies.
5. **Reporting.** Attribution and weekly reports. This completes P0. Stages 2 to 5 pass through the launch gates in section 14.
6. **P1.** Paid ads, landing pages, tests, email, influencer, budgets, 11oils.
7. **P2.** Self-serve, billing, contracts, managed tier, CRM sync.

## 19. Dependencies

- **Platform approvals with long lead times:** Meta business verification and app review for Instagram and Facebook; LinkedIn and YouTube API access; ad-platform developer access for P1; WhatsApp business API if it is added later.
- **Brand assets:** real photos and footage from Aztek.
- **Hosting:** `marketing.sarathi.gvcc.in` has no DNS record yet. `n8n.sarathi.gvcc.in` and `sarathi.gvcc.in` both point to 72.62.195.236.
- **Existing work to build on:** Aztek's live content pipeline and SEO foundation; the n8n instance, where the two existing workflows must not be changed.
- **Paid tools:** the owner is willing to use paid tools. Tool selection and pricing are settled in the technical specs.

## 20. Open questions

**Blocking** means the PRD cannot be finalised without it.

| # | Question | Who answers | Blocking |
|---|---|---|---|
| 1 | What is the product called? | Owner | No |
| 2 | Aztek's current baseline: marketing staff count and roles, posts and articles per month, leads per month | Owner | Yes, for success targets |
| 3 | How many minutes a day will the owner spend on approvals? | Owner | Yes, for success targets |
| 4 | Deadline for Aztek, and for the first outside client | Owner | Yes, for phasing |
| 5 | Monthly ceiling for paid tools, excluding ad spend | Owner | Yes, for tool selection |
| 6 | What does 11oils sell, to whom, and when does it launch? | Owner | No |
| 7 | Does the dashboard go on the same server as n8n, and who controls the DNS? | Owner | No |
| 8 | Who is the named salesperson for Aztek hot leads, and which lead types go to them? | Owner | Yes, before the leads phase |
| 9 | How are partners chosen for routed leads, and how do they report outcomes? | Owner | Yes, before the leads phase |
| 10 | What are the pipeline stages for each Aztek lead type? | Owner | Yes, before the leads phase |
| 11 | Pricing, plan limits and what the managed tier includes | Owner | No, before P2 |
| 12 | Who is the target outside customer (industry, size, country)? | Owner | No, before P2 |
| 13 | Data protection obligations for stored leads, and contract templates | Lawyer | Yes, before leads and before P2 |
| 14 | Is WhatsApp a channel for leads or replies? It was not among the launch channels. | Owner | No |
| 15 | How many revision rounds before an item escalates? | Owner | No |
| 16 | What makes a lead "qualified", for each Aztek lead type? | Owner | Yes, for lead metrics |
| 17 | Is a deal value recorded for each lead type, including sales made by partners? | Owner | Yes, for revenue and return metrics |
| 18 | How long is the usual sales cycle for each lead type? | Owner | Yes, for lookback windows |
| 19 | How long is the pilot's measured period, and does the current team keep working alongside it? | Owner | Yes, for gates |
| 20 | Who supports customers of the product? No role in the 22 covers it. | Owner | No, before P2 |
| 21 | Who sells the product to new customers? No role in the 22 covers it. | Owner | No, before P2 |
| 22 | Must automated replies and chats say they are automated? | Owner, lawyer | Yes, before replies go live |
| 23 | How long is lead data kept, and where must it be stored? | Owner, lawyer | Yes, before leads |
| 24 | Which countries' privacy laws apply to leads from abroad? | Lawyer | Yes, before distributor leads |
| 25 | Who owns content and assets after a customer leaves? | Lawyer | No, before P2 |
| 26 | Can Aztek warranty registrations be used to confirm partner sales? | Owner, engineering | No |
| 27 | What does the current team cost per month? Needed to compare cost per item and per lead. | Owner | Yes, for cost targets |
| 28 | With no staff, who responds to an incident when the owner is unavailable? | Owner | Yes, before go-live |
| 29 | Which advertising standards and platform policies apply in each market the brand sells into? | Owner, lawyer | Yes, before content goes live |

## 21. Recommended defaults awaiting confirmation

These are recommendations, not facts and not decisions. None is final until the owner confirms it. Each can be changed without redesign.

| Item | Recommended default | Basis |
|---|---|---|
| Baseline period | The 90 days before go-live | Long enough to smooth out weekly swings |
| Pilot measured period | 90 days after gate 4 | Matches the 90-day goals in the strategy brief |
| Shadow period | 2 weeks | Enough items to judge quality before anything is public |
| Consecutive period for gate 5 | 2 months meeting targets | Avoids declaring success on one good month |
| Lead credit | Last non-direct touch; first touch also stored | Common practice; simple to explain |
| Lookback, touch to lead | 30 days | Common practice |
| Lookback, lead to sale | 90 days for car owners; 180 days for partners and distributors | Assumes business deals take longer; to be replaced by real cycle lengths |
| Channel priority | Paid ad, email, organic social, organic search, referral, direct | Paid and email touches are the most reliably recorded |
| Link tagging | As in section 13.3 | Needed for consistent reports |
| Partner outcome reminders | 7, 14 and 30 days; "outcome unknown" at 45 days | To be adjusted to real partner behaviour |
| Revision limit before escalation | 2 rounds | Carried over from the earlier design |
| Rollback: failed publication rate | Above 5 percent of scheduled publishes in a week | Starting point; adjust after gate 3 |
| Rollback: leads below baseline | 20 percent below for 2 consecutive months | Starting point |
| Email complaint rate | Aim below 0.1 percent; pause sending at 0.3 percent | The limit large mailbox providers publish for bulk senders |
| Reply sample review | 10 percent of automatic replies each week | Starting point |
| Two-step sign-in | Required for owner and approvers | These accounts can publish and spend |
| Dashboard availability | 99.5 percent a month | Starting point for a single-server setup |
| Publishing timeliness | Within 5 minutes of the scheduled time | Starting point |
| Backups | Daily; at most 24 hours of data lost; restored within 4 hours | Starting point |
| Backup retention and copy | 30 days, with a copy kept away from the main server | Starting point |
| Restore test | Monthly | A backup is only proven by restoring it |
| Disaster recovery rehearsal | Twice a year | Starting point |
| Audit-log retention | 2 years | Starting point; subject to legal review |
| Deletion on request | Completed within 30 days | Starting point; subject to legal review |
| Token expiry warning | 7 days before expiry | Leaves time to reconnect |
| Key rotation | Every 90 days, and at once after suspected exposure | Common practice |
| Incident response | Severity 1: acknowledged within 1 hour. Severity 2: within 4 hours. Severity 3: next working day. | Depends on the answer to open question 28 |
| Confidence thresholds | No figure proposed; set at gate 2 from evaluation results | A figure chosen now would be a guess |
| Cost ceilings | No figure proposed; set from the first month of real usage | A figure chosen now would be a guess |

## 22. Decisions on record

Answers given by the owner on 2026-10-03.

| Topic | Decision |
|---|---|
| Commercial model | Self-serve tier and managed tier |
| First brand | Aztek. 11oils is also an own brand. |
| Success criteria | Lead volume, content output and quality, low owner time, organic growth: all four |
| Physical-world roles | AI plus the brand's real uploaded assets |
| Paid ads authority | Capped autonomy inside an approved budget |
| Aztek launch channels | Instagram, Facebook, LinkedIn, YouTube |
| Aztek lead types | Car owners, installers and studios, distributors abroad |
| Website changes | Landing pages only; recommendations for the main site |
| Finance and legal scope | Subscription billing, client contracts, content compliance checks, budget and spend tracking |
| Languages | English |
| Hot-lead handling | Agent books, hand to a salesperson, route to a partner |
| Leads and pipeline | Built into the product, with optional sync to a customer's CRM |
| Public replies | Routine replies automatic; the rest to the approver |
| Approvals | The owner for own brands; the client's named person for outside clients |
| Onboarding | Research first, then a tailored questionnaire |
| Agent structure | One agent for each of the 22 agency roles |
| Paid tools | Acceptable |
