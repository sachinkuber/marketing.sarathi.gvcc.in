# Sachin to Provide

| Document control | |
|---|---|
| Version | 2 |
| Date | 2026-10-04 |
| Owner | Sachin Tripathi |
| Purpose | One list of everything the project needs from the owner: access, accounts, facts, decisions and confirmations |
| Canonical source | `docs/sachin-to-provide.md`. The Word file is generated from it. |
| Sources | Master PRD version 3 (sections 20 and 21), Architecture version 2, Phase 1 spec |

**How to use this list.** Items are grouped by when they are needed. Each has an ID so a reply can be as short as "A2: done" or "B1: 3 staff, 20 posts, 40 leads". The Status column is updated as answers arrive.

**Secrets.** Never put a password, API key or token in this document, in chat or in the repository. Section 9 says how to hand each one over.

## 1. Needed now: before Phase 1 can be deployed

None of these stops development. All of them stop deployment.

| ID | What I need | Exactly what to provide | Why I need it | Status |
|---|---|---|---|---|
| A1 | Access to the shared server (72.62.195.236) | Read access by SSH, or a written note of: processors, memory, free disk, current load, and how n8n and the reverse proxy are installed (Docker or not, which proxy) | To confirm the server has room for the product without slowing the existing n8n workflows, and to fit the product into the existing proxy and TLS setup | Open |
| A2 | DNS record | An A record for `marketing.sarathi.gvcc.in` pointing to the server, or the name of whoever controls the `gvcc.in` DNS | The dashboard cannot be reached or get a TLS certificate without it | Open |
| A3 | Anthropic API key for the product | A key created for this product only, with a monthly spend limit you choose | Every agent runs on the Claude API. A separate key keeps the product's cost visible and lets it be revoked alone. | Open |
| A4 | Off-server backup storage | The storage service and bucket to use, and credentials limited to that bucket | One server is one point of failure. Daily encrypted backups must live somewhere else. A restored backup is part of gate 0. | Open |
| A5 | Write-once storage for the audit log | A bucket with object lock (no overwrite or delete during retention), or agreement that I choose one | An audit table inside the same database can be altered by anyone who controls the database. The off-server copy is what makes tampering detectable. | Open |
| A6 | Sending address for notifications | The address the product sends from (for example `noreply@...`) and the sending service or SMTP account | You and later client approvers are told by email when something waits for approval or an alert fires | Open |
| A7 | Code hosting | A GitHub (or other) repository for this project, and access for me to push | The code and documents currently exist only on your laptop. A remote copy is needed for safety and for automated tests. | Open |
| A8 | Permission to commit | A yes or no: may I commit the approved documents and, later, code to the local repository as work progresses? | Nothing has been committed so far because you have not asked for it | Done |
| A10 | Error-tracking account | A Sentry account (or agreement that I create one) and a project for the product | Errors in the product are reported there so failures are never silent. Personal data is removed before anything is sent. | Open |
| A11 | Second alert channel | Which channel urgent alerts should also go to, besides email: for example SMS, Telegram or a phone push service | An alert that only goes to email can be missed. You are the only responder. | Open |
| A12 | Provider administrator key (optional) | An Anthropic administrator key with read access to usage and cost, or agreement to compare by hand each month | A crash at the wrong moment can cause a model request to be sent, and charged, twice. The product records every request and compares its ledger with the provider's figures. The key automates that comparison. | Open |
| A13 | Uptime checker account | An account with a hosted uptime-checking service, or agreement that I choose one | It must run outside the server. A checker on the same server goes down with it and reports nothing. | Open |
| A9 | Your sign-in details | The email address for your platform-owner account, and a phone with an authenticator app | You are the first user. A second factor is mandatory for your role. | Open |

## 2. Needed to finalise the success targets in the PRD

Without these, the product can be built but "does it work?" cannot be measured.

| ID | What I need | Exactly what to provide | Why I need it | Status |
|---|---|---|---|---|
| B1 | Aztek's current baseline | Marketing staff count and their roles; posts and articles published per month; leads per month. Best taken from the last 90 days. | The goals are "at least what the current team does". There is no target without the current figure. (PRD question 2) | Open |
| B2 | What the current team costs | Monthly cost of the marketing team and the tools they use | To compare cost per content item and cost per lead against today (PRD question 27) | Open |
| B3 | Your daily approval time | Minutes per day you are willing to spend approving | One of your four success criteria. It also decides how much the agents send you and how much they batch. (PRD question 3) | Open |
| B4 | Deadlines | A date for Aztek running on the product, and for the first outside client | No dates are in any document because none has been given. Phasing and the estimate depend on it. (PRD question 4) | Open |
| B5 | Monthly tool budget | A ceiling for paid tools, not counting ad spend | Decides which keyword, image, video and publishing tools are chosen in Phase 3 (PRD question 5) | Open |
| B6 | Pilot length and parallel running | How long the measured pilot runs, and whether the current team keeps working alongside it | Sets when gate 5 can pass. My recommendation is a parallel run until then. (PRD question 19) | Open |
| B7 | What "qualified lead" means | For each Aztek lead type (car owner, installer or studio, distributor abroad): the conditions that make a lead qualified | Lead metrics and the agent's qualification step both depend on this definition (PRD question 16) | Open |
| B8 | Deal values | Whether a sale value is recorded for each lead type, including sales made by partners | Needed for revenue influenced and paid-media return (PRD question 17) | Open |
| B9 | Sales-cycle length | Typical time from lead to sale for each lead type | Sets the attribution lookback windows. My proposed 90 and 180 days are placeholders. (PRD question 18) | Open |

## 3. Needed before Phase 2: onboarding and strategy

| ID | What I need | Exactly what to provide | Why I need it | Status |
|---|---|---|---|---|
| C1 | Aztek's social profiles | The links to Aztek's Instagram, Facebook, LinkedIn and YouTube accounts | The research agent studies them before building the questionnaire | Open |
| C2 | Brand material | Brochures, product sheets, price lists, presentations, brand guidelines (logo files, colours, fonts) | Research starts from what is public; these fill the gaps and set the visual system | Open |
| C3 | Search Console and analytics access | Add the product's service account (I will give the address) to Aztek's Search Console property and the GA4 property | To read real search queries, pages and traffic for research and later reporting | Open |
| C4 | Competitor list | Confirm or correct: UltrashieldX, Cosmo PPF/Sunshield, Intakt PPF, XPEL, 3M India | Research compares Aztek against named competitors; these five come from the earlier audit work | Open |
| C5 | Questionnaire answers | About 20 to 30 answers on the dashboard, after research has run | The agent asks only what research could not settle. The answers become the brand profile. | Not yet due |
| C6 | Sign-off on the verified-facts list | Confirm each fact, with its source: numbers, certifications, warranty terms, countries, partner counts | No content may state a fact that is not on this list. Known so far: "100+ certified studios", "50+ Partners", "5 Countries". | Not yet due |
| C7 | Things Aztek must never say | Forbidden topics and claims, competitors not to be named, tone limits | Becomes the brand safety rulebook that every item is checked against | Open |
| C8 | Examples of good work | 10 to 20 past posts, articles or ads you consider good, and a few you consider bad | They seed the evaluation set that every agent change must pass | Open |
| C9 | 11oils | What it sells, to whom, and when it should launch | It is the second brand and the first test that onboarding works without code changes (PRD question 6) | Open |

## 4. Needed before Phase 3: content and publishing — start these now

The first four take weeks and can be refused. Starting now avoids a stall later.

| ID | What I need | Exactly what to provide | Why I need it | Status |
|---|---|---|---|---|
| D1 | Meta business verification | Complete verification of the business in Meta Business settings; tell me when it is done | Required before an app can publish to Instagram and Facebook | Open |
| D2 | Meta app review | A Meta developer account under the business, and agreement that I prepare the app review submission for you to submit | Publishing and reading comments through official routes needs approved permissions | Open |
| D3 | LinkedIn access | Admin rights on the Aztek company page for the account that will authorise the product, and a LinkedIn developer application | Posting to a company page needs an approved application and a page admin | Open |
| D4 | YouTube access | Owner or manager rights on the Aztek channel, and a Google Cloud project for the product | Uploading needs an authorised project; unverified projects are limited | Open |
| D5 | Real photos and footage | Product, installation and vehicle photos and video, with confirmation that Aztek may use them | You chose "AI plus real assets". Visual agents work from these and only generate to fill gaps. | Open |
| D6 | Consent for people shown | Confirmation that anyone identifiable in the assets has agreed to their use | The product will not publish a person's likeness without it | Open |
| D7 | Paid tool accounts | Accounts for the chosen image, video, voice and keyword tools. The list is fixed in the Phase 3 spec, within the budget in B5. | The agents call these tools through their own keys | Not yet due |
| D8 | Approved link domains | The domains content is allowed to link to (for example `aztek.global`) | Every link in content is checked against this list before publishing | Open |
| D9 | Aztek site change approval | Approval to add the draft-only article endpoint to the Aztek site and deploy it | Articles are delivered to the site as drafts through it. It cannot publish. | Open |
| D10 | Advertising rules per market | Which countries Aztek sells into, so the right advertising standards can be applied | The policy check needs to know which rules apply (PRD question 29) | Open |

## 5. Needed before Phase 4: leads and sales

| ID | What I need | Exactly what to provide | Why I need it | Status |
|---|---|---|---|---|
| E1 | Named salesperson | Name, email and phone of the person who takes over hot leads, and which lead types go to them | The agent hands over to a named person; it cannot hand over to a role (PRD question 8) | Open |
| E2 | Partner routing rule | The list of partners with locations, and the rule for choosing one (nearest, by city, by capacity) | Car-owner leads are routed to a partner (PRD question 9) | Open |
| E3 | How partners report outcomes | Agreement that partners report won or lost through a link, and who chases them | Without it, partner sales cannot be attributed (PRD question 9) | Open |
| E4 | Pipeline stages | The stages for each lead type, from new to won or lost | The built-in pipeline is configured from these (PRD question 10) | Open |
| E5 | Approved answers | Answers to common questions: price range, locations, warranty, booking, timing | Routine replies are sent only from this approved list | Open |
| E6 | Booking calendar | The calendar bookings go into, and the working hours | "Agent books it" needs somewhere to book | Open |
| E7 | Email sending domain | The domain for lead follow-up email, and the ability to add DNS records for it | Email from an unauthenticated domain lands in spam | Open |
| E8 | WhatsApp decision | Yes or no: is WhatsApp a channel for leads or replies? | It was not among the four launch channels, but the site already has a WhatsApp button (PRD question 14) | Open |
| E9 | Warranty data use | Yes or no: may warranty registrations be matched to leads to confirm a partner sale? | It would confirm sales without relying on partner reports (PRD question 26) | Open |
| E10 | Incident cover | Who responds to an urgent problem when you are unavailable | With no staff you are the only responder. This blocks go-live. (PRD question 28) | Open |

## 6. Needed from a lawyer

| ID | What I need | Exactly what to provide | Why I need it | Status |
|---|---|---|---|---|
| F1 | A lawyer to consult | Name of the lawyer or firm who will answer the items below | I can flag legal risk; I cannot give legal advice | Open |
| F2 | Lead data rules | How long lead data may be kept, where it must be stored, and what consent wording is needed | Sets retention, deletion and consent capture (PRD questions 13 and 23) | Open |
| F3 | Overseas leads | Which countries' privacy laws apply to distributor leads from abroad | May add obligations beyond India's law (PRD question 24) | Open |
| F4 | Automated replies | Whether automated replies and chats must say they are automated | Decides the wording of every automatic reply (PRD question 22) | Open |
| F5 | Incident notice periods | How quickly customers and authorities must be told of a data incident | Sets the incident process timings | Open |
| F6 | Contract templates | Approved client agreement templates | The contracts agent fills templates; it does not write contracts (PRD question 13) | Not yet due |
| F8 | Compliance profiles | Approval, by the lawyer, of a compliance profile for each market, channel and content type Aztek publishes to. I draft each one from the named sources. First needed: India, for Instagram, Facebook, LinkedIn, YouTube and site articles. | The product blocks publication to a market and channel until its profile is approved. Without them nothing can go live in Phase 3. | Open |
| F7 | Content ownership | Who owns content and assets when a customer leaves | Needed for the client agreement and offboarding (PRD question 25) | Not yet due |

## 7. Needed before selling to outside clients

| ID | What I need | Exactly what to provide | Why I need it | Status |
|---|---|---|---|---|
| G1 | Product name | The name to use in the product and documents | Everything currently says "the platform" (PRD question 1) | Open |
| G2 | Target customer | Industry, company size and country of the first outside customers | Shapes onboarding, pricing and which platform rules apply (PRD question 12) | Not yet due |
| G3 | Pricing and plans | Prices, plan limits, and what the managed tier includes | Needed for billing, margin per plan and service commitments (PRD question 11) | Not yet due |
| G4 | Customer support | Who answers customers of the product | None of the 22 agent roles covers it (PRD question 20) | Not yet due |
| G5 | Selling the product | Who finds and signs new customers | None of the 22 agent roles covers it (PRD question 21) | Not yet due |
| G6 | Payment provider account | A merchant account for subscription billing | Subscription billing runs through it | Not yet due |

## 8. Recommended defaults for you to confirm

These are my recommendations from PRD section 21. Each works as a starting point. Reply "H: all agreed" or name the ones to change.

| ID | Item | Recommended default | Why I need your confirmation | Status |
|---|---|---|---|---|
| H1 | Baseline period | The 90 days before go-live | Sets what the product is compared against | Open |
| H2 | Shadow period | 2 weeks of content into the inbox with nothing published | Sets when the first post can go out | Open |
| H3 | Pilot success period | Targets met for 2 consecutive months | Sets when staff can be redirected | Open |
| H4 | Lead credit | Last non-direct touch; first touch also stored | Decides which content gets credit for a lead | Open |
| H5 | Lookback windows | 30 days touch to lead; 90 days lead to sale for car owners, 180 for partners and distributors | Replaced by real figures once B9 is answered | Open |
| H6 | Revision limit | 2 rounds before an item comes to you | More rounds mean less of your time but slower output | Open |
| H7 | Partner reminders | At 7, 14 and 30 days; "outcome unknown" at 45 | Sets how hard partners are chased | Open |
| H8 | Rollback: failed publishing | Hand back to people above 5 percent failures in a week | Sets how much failure is tolerated | Open |
| H9 | Rollback: leads | Hand back if 20 percent below baseline for 2 months | Sets when the pilot is judged to be failing | Open |
| H10 | Email complaints | Aim below 0.1 percent; pause sending at 0.3 percent | Protects the sending domain | Open |
| H11 | Reply sample review | 10 percent of automatic replies each week | Your time against how closely replies are watched | Open |
| H12 | Audit-log retention | 2 years | Subject to F2 | Open |
| H13 | Deletion on request | Within 30 days | Subject to F2 | Open |
| H14 | Backups | Daily; kept 30 days; restore tested monthly | Sets storage cost and how much data could be lost | Open |
| H15 | Availability | 99.5 percent a month on one server | A higher figure needs a second server | Open |
| H16 | Incident response | Severity 1 within 1 hour, 2 within 4 hours, 3 next working day | Depends on E10 | Open |
| H17 | Model | `claude-opus-5-5` for every agent to start | Cheaper models for high-volume agents are your decision once real costs are measured | Open |

## 9. How to hand over secrets

| Secret | How to hand it over |
|---|---|
| Server access (A1) | Add my public SSH key to the server, or run the inspection commands yourself and paste the output |
| Anthropic API key (A3) | Put it in the product's secrets file on the server at deployment. For local development, set it in your own shell environment. |
| Storage credentials (A4, A5) | The server's secrets file |
| Sending account (A6) | The server's secrets file |
| n8n shared secret | I generate it; it is stored as an n8n credential and in the server's secrets file |
| Platform authorisations (D1 to D4) | You sign in on each platform's own consent screen from the dashboard. No password is ever typed into the product or given to me. |
| Paid tool keys (D7) | The server's secrets file |

## 10. Already provided

| Item | What was provided | Date |
|---|---|---|
| Commercial model | Self-serve tier and managed tier | 2026-10-03 |
| Success criteria | Lead volume, content output and quality, low owner time, organic growth | 2026-10-03 |
| Launch channels | Instagram, Facebook, LinkedIn, YouTube | 2026-10-03 |
| Lead types | Car owners, installers and studios, distributors abroad | 2026-10-03 |
| Languages | English | 2026-10-03 |
| Visual assets approach | AI plus real uploaded assets | 2026-10-03 |
| Paid ads authority | Capped autonomy inside an approved budget | 2026-10-03 |
| Website changes | Landing pages only; recommendations for the main site | 2026-10-03 |
| Hot-lead handling | Agent books, hand to a salesperson, route to a partner | 2026-10-03 |
| Leads and pipeline | Built in, with optional sync to a customer's CRM | 2026-10-03 |
| Public replies | Routine replies automatic; the rest to the approver | 2026-10-03 |
| Approver | You for own brands; the client's named person for outside clients | 2026-10-03 |
| Paid tools | Acceptable | 2026-10-03 |
| Master PRD version 3 | Approved | 2026-10-04 |
| Design approach | Hybrid: coded agent service plus n8n for triggers | 2026-10-04 |
| Hosting | Start on the n8n server; move when load requires or before the first outside client | 2026-10-04 |
| Architecture version 2 | Approved in full, including its nine decision records | 2026-10-04 |
| Phase 1 spec version 3 | Approved, then replaced by version 4 | 2026-10-04 |
| Bulk approval | Flexible: a setting per brand and per kind of item | 2026-10-04 |
| Calendar approval | Flexible: per item, day or week. Default one week. | 2026-10-04 |
| Waiting items | Customisable; two to three reminders, then escalation | 2026-10-04 |
| Second factor for Viewers | Not required | 2026-10-04 |
| Home screen | Leads with results and progress | 2026-10-04 |
| Overdue approvals | Shown as a pop-up window and a dashboard banner; never approved automatically | 2026-10-04 |
| App flow version 2 | Approved | 2026-10-04 |
| Tech stack version 1 | Approved, including Express, npm and the listed exceptions | 2026-10-04 |
| Content guidelines version 2 | Approved as written | 2026-10-04 |
| Phase 1 spec version 4 | Approved | 2026-10-04 |
| Cost currency | Every cost recorded in both US dollars and Indian rupees | 2026-10-04 |
| Retention of job inputs and notifications | 90 days | 2026-10-04 |
| Database schema version 2 | Approved. Later-phase tables stay provisional. | 2026-10-04 |
| Phased implementation plan version 1 | Approved, with its assumption that Claude Code builds and the owner reviews | 2026-10-04 |
| Permission to commit (A8) | Yes | 2026-10-04 |
