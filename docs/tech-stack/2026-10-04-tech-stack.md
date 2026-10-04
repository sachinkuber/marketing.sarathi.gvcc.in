# AI Marketing Agency Platform — Tech Stack

| Document control | |
|---|---|
| Version | 2 |
| Status | **Approved** |
| Approved by | Sachin Tripathi, platform owner, on 2026-10-04 ("tech stack version 2 approved"). Version 1 was approved the same day. |
| Changes in version 2 | ESLint 9.39.5 replaced by 10.10.0. A trial install showed version 9 is marked "no longer supported" by its publisher. |
| Date | 2026-10-04 |
| Owner | Sachin Tripathi (platform owner) |
| Prepared by | Claude Code |
| Canonical source | `docs/tech-stack/2026-10-04-tech-stack.md`. The Word file is generated from it. |
| Based on | Architecture version 2 (approved), Phase 1 spec version 3 (approved), App flow version 2 (approved) |
| Owner's instruction | "Choose the most stable, widely-used option for each job — not the newest." |

## 1. How each choice was made

Every figure in this document was looked up on 2026-10-04: weekly downloads and release dates from the npm registry, runtime releases from nodejs.org, database releases from postgresql.org. Nothing is from memory.

**Rules applied**

1. **Most widely used tool for the job**, measured by weekly downloads, unless an approved architecture decision rules it out.
2. **A major version that has been out for about a year or more.** Where the newest major is younger than that, the previous one is used, provided its publisher still supports it.
3. **No release younger than 30 days.** The pinned version is the newest release in the chosen major that was at least 30 days old on 2026-10-04.
4. **Security fixes are the exception to rule 3.** A security patch is taken as soon as it has been reviewed and the tests pass.
5. **Fewer moving parts.** Where a tool that already ships with something we use does the job, no extra tool is added.

Section 3 lists every place where a choice does not fully meet these rules, and why.

## 2. The stack

### 2.1 Runtime and language

| Job | Choice | Version | Evidence | Why this and not the alternative |
|---|---|---|---|---|
| Runtime | Node.js, long-term-support line 24 | 24.20.0 | In long-term support since October 2025 | The current long-term-support line. Line 26 is not yet long-term support. |
| Package manager | npm | 11.19.0 | Ships with Node 24 | Comes with the runtime, so there is nothing extra to install or keep in step. pnpm is also widely used but is a separate tool. |
| Language | TypeScript | 5.9.3 | 354.8 million downloads a week. The 5 line has been in use since March 2023. | Version 7 came out in July 2026 and version 6 in March 2026. Both are too new under rule 2. |

### 2.2 Data

| Job | Choice | Version | Evidence | Why this and not the alternative |
|---|---|---|---|---|
| Database | PostgreSQL | 17.11 | Version 17 has been out since September 2024; this is its eleventh maintenance release | Version 18 is newer. The newest maintenance release of 17 is used because those releases are security and bug fixes (rule 4). |
| Database driver | pg | 8.23.0 | 70.8 million a week. The 8 line since March 2020. | The standard Postgres driver for Node |
| Schema changes | node-pg-migrate, running plain SQL files | 8.0.4 | In use since 2014. The 8 line since May 2025. | Version 9 came out in July 2026. Row-level security, roles and triggers are written in SQL either way. |
| Queries | Kysely | 0.29.5 | 21.4 million a week, in use since February 2021 | See section 3. Knex is older (2013) but has a third of the use and weaker type checking. Prisma is widely used but manages the schema itself, which conflicts with hand-written security policies. |
| Job queue | pg-boss | 12.30.0 | In use since March 2016. 2.6 million a week. | See section 3. BullMQ has more users but needs a second database (Redis) and cannot create a job in the same transaction as business data, which the approved architecture requires. |

### 2.3 Core service

| Job | Choice | Version | Evidence | Why this and not the alternative |
|---|---|---|---|---|
| HTTP framework | Express | 5.2.1 | 165.8 million a week, in use since 2010. The 5 line since September 2024. | The most widely used by a wide margin. Fastify (17.3 million a week) was the earlier choice; it is sound but has a tenth of the use. |
| Security headers | helmet | 8.3.0 | 18.7 million a week, in use since 2012 | The standard companion to Express |
| Input validation | Zod | 4.5.4 | 373.9 million a week. The 4 line since July 2025. | The most widely used validation library for TypeScript |
| Sign-in | Better Auth, with its two-factor plugin | 1.7.2 | 12.0 million a week. The 1 line since November 2024. | See section 3. It is now more widely used than next-auth (7.5 million) and Passport (9.9 million), and neither of those provides a second factor. |
| Logging | pino, with pino-http | 10.3.1 and 11.0.0 | 62.1 million a week, in use since 2016 | About twice the use of winston (33.0 million), with built-in removal of sensitive fields |
| Sending email | Nodemailer | 9.1.1 | 28.2 million a week, in use since 2011 | The standard mail library for Node. Version 10 came out in September 2026. |

### 2.4 Dashboard

| Job | Choice | Version | Evidence | Why this and not the alternative |
|---|---|---|---|---|
| Framework | Next.js | 16.3.4 | 74.7 million a week. The 16 line since October 2025. | The most widely used React framework, and the one the Aztek site already runs. See section 3. |
| UI library | React | 19.2.8 | 218.1 million a week. The 19 line since December 2024. | Required by the framework |
| Styling | Tailwind CSS | 4.3.3 | 158.9 million a week. The 4 line since January 2025. | The same as the Aztek site |
| Forms | React Hook Form | 7.87.0 | 69.1 million a week. The 7 line since April 2021. | The most widely used form library; works with Zod |
| Charts | Recharts | 3.10.1 | 69.6 million a week, in use since 2015 | Needed from phase 5. The 3 line since June 2025. |

### 2.5 Agents

| Job | Choice | Version | Evidence | Why this and not the alternative |
|---|---|---|---|---|
| Model provider | Claude API, model `claude-opus-5-5` | — | Architecture section 14 | Set per agent. A cheaper model for a high-volume agent is the owner's decision. |
| Model SDK | Official Anthropic TypeScript SDK | 0.124.0 | 51.1 million a week | The provider's own library. See section 3. |

### 2.6 Quality

| Job | Choice | Version | Evidence | Why this and not the alternative |
|---|---|---|---|---|
| Unit and integration tests | Vitest | 4.1.11 | 135.4 million a week. The 4 line since October 2025. | More than twice the use of Jest (56.4 million). Version 5 came out on 30 September 2026 and is too new. |
| Browser tests | Playwright | 1.63.0 | 82.4 million a week, in use since 2020 | About eleven times the use of Cypress (7.3 million) |
| Code checks | ESLint, with typescript-eslint 8.69.0 | 10.10.0 | 193.3 million a week | See section 3. Version 9 is no longer supported by its publisher, so it gets no fixes. |
| Formatting | Prettier | 3.9.6 | 165.3 million a week. The 3 line since July 2023. | The standard formatter |
| Secret scanning | gitleaks, in the automated checks | Recorded at setup | — | Stops a key being committed |
| Automated checks | GitHub Actions | — | Already used for the Aztek site | Depends on owner item A7 (code hosting) |

### 2.7 Operations

| Job | Choice | Version | Evidence | Why this and not the alternative |
|---|---|---|---|---|
| Containers | Docker with the Compose plugin | Whatever the server runs | Approved hosting decision | Recorded when the server is inspected (owner item A1) |
| Reverse proxy | The proxy already on the server | Recorded at inspection | — | If there is none: nginx, stable branch, which the Aztek production server already uses |
| Error tracking | Sentry | SDK 10.73.0 | 44.7 million a week | The most widely used. SDK version 11 came out in September 2026. Needs an account (A10). |
| Asset store, backups, audit export | S3-compatible object storage; AWS S3 recommended | SDK 3.1127.0 | 56.3 million a week for the SDK | The most widely used object store. It has object lock, which the write-once audit export needs. The provider is the owner's choice (A4, A5). |
| Uptime check | A hosted checker outside the server | To be chosen | — | A checker on the same server goes down with it |

## 3. Where a choice does not fully meet the rules

| Choice | Which rule it bends | Why it is still the choice | Safeguard |
|---|---|---|---|
| **Kysely 0.29.5** | Its version number is below 1.0, which normally signals an unfinished library | It has been in production use since 2021 and has 21.4 million downloads a week, more than three times Knex. The sign-in library uses it internally, so it is in the product whether or not we call it directly. | Exact version pinned. All queries go through one package (`packages/db`), so it can be replaced without touching the rest. |
| **Better Auth 1.7.2** | The youngest library in the stack: first released April 2024 | The older options (Passport, next-auth) have no second factor, so we would write that security code ourselves. That is a bigger risk than a younger library that provides it. | Its database schema is a reviewed, committed migration; it cannot change tables at run time. Sign-in has its own acceptance tests. |
| **pg-boss 12.30.0** | Major version 12 is 11 months old, just under a year, and releases come often | The features the approved design relies on (worker heartbeats, per-group concurrency, notification dispatch) were confirmed against the version 12 documentation. Version 10 is older but those features are not confirmed there. | The first work package confirms each feature on this exact version before anything is built on it. The queue sits behind our own interface. |
| **Next.js 16.3.4** | Major version 16 is 12 months old, right at the limit. Version 15 is older and still maintained. | It matches the Aztek site, so there is one set of conventions to know. | Its bundled documentation is read before any code is written. Version 15.5 is the fallback. |
| **Anthropic SDK 0.124.0** | Version number below 1.0 | It is the provider's official library and there is no alternative with the same support | The first work package confirms this version works with `claude-opus-5-5`. If it does not, the newest version is used as a stated exception to the 30-day rule. |
| **ESLint 10.10.0** | Major version 10 is 8 months old, under the one-year rule | Version 9, which met the rule, is marked "no longer supported". An unsupported tool is a worse risk than a younger one. It only checks code; it is not part of the running product. | The release is 30 days old. The TypeScript plugin pinned with it supports version 10. |
| **PostgreSQL 17.11** | The newest maintenance release, so it may be under 30 days old | Maintenance releases are security and bug fixes (rule 4) | Tested like any other change |

## 4. What this changes in the approved Phase 1 spec

The Phase 1 spec version 3 pinned the newest releases. This document replaces its section 3. The spec needs a version 4 to carry these changes.

| Component | Phase 1 spec version 3 | This document | Reason |
|---|---|---|---|
| Node.js | 24.21.0 | 24.20.0 | 30-day rule |
| Package manager | pnpm 12.9.1 | npm 11.19.0 | Ships with the runtime |
| TypeScript | 7.0.2 | 5.9.3 | Version 7 is three months old |
| Core HTTP framework | Fastify 5.12.5 | Express 5.2.1 | Ten times the use |
| Zod | 4.6.5 | 4.5.4 | 30-day rule |
| Kysely | 0.29.6 | 0.29.5 | 30-day rule |
| Better Auth | 1.7.7 | 1.7.2 | 30-day rule |
| pg-boss | 12.36.0 | 12.30.0 | 30-day rule |
| pg | 8.23.1 | 8.23.0 | 30-day rule |
| Next.js and React | 16.3.8 and 19.3.0 | 16.3.4 and 19.2.8 | 30-day rule |
| Anthropic SDK | 0.131.0 | 0.124.0 | 30-day rule |
| Vitest | 5.0.3 | 4.1.11 | Version 5 is days old |
| pino | 10.4.0 | 10.3.1 | 30-day rule |
| Sentry SDK | 11.4.0 | 10.73.0 | Version 11 is a month old |
| Reverse proxy, if none exists | Caddy | nginx | Already used on the Aztek server |
| Unchanged | PostgreSQL 17.11, Playwright 1.63.0 | | |

Design is not affected. The core service does the same things on Express as on Fastify; only the framework under it changes.

## 5. Not chosen yet

These belong to later phases and are chosen in those phases' specs, by the same rules and within the tool budget (owner item B5).

| Job | Phase | Depends on |
|---|---|---|
| Social publishing route: each platform's own API, or one publishing provider | 3 | Platform approvals (D1 to D4) |
| Image, video and voice generation | 3 | Tool budget (B5); a trial with real Aztek assets |
| Keyword and search data | 3 | Tool budget (B5) |
| Key management for platform tokens | 3 | Storage provider (A4) |
| Email sending service for leads | 4 | Sending domain (E7) |
| Calendar booking | 4 | Booking calendar (E6) |
| Ad platform access | After pilot | Ad accounts |
| Payments and e-signature | For sale | Payment provider (G6) |

## 6. Keeping it stable

- **Exact versions** in the package file, with the lockfile committed. No version ranges.
- **The Node version** is fixed in the project; the build fails on any other.
- **Container images** are referenced by digest.
- **Upgrades** happen on a schedule, not as they appear: once a month, one reviewed change, taking only releases at least 30 days old, with the full test suite passing.
- **Security fixes** are taken as soon as reviewed and tested.
- **A new major version** is considered only after it has been out for about a year.

## 7. Points for the owner

| # | Point |
|---|---|
| 1 | Confirm the two changes of tool, not just of version: Express in place of Fastify, and npm in place of pnpm. |
| 2 | Confirm the exceptions in section 3, in particular Better Auth and Kysely. |
| 3 | Storage provider for assets, backups and the audit export (A4, A5). AWS S3 is recommended. |
| 4 | A hosted uptime checker needs an account (owner item A13). |
