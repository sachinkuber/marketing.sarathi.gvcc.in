# Proposed PRD change: AI presenter (avatar) videos

| Document control | |
|---|---|
| Status | **Proposed — awaiting owner approval** |
| Date | 2026-11-19 |
| Requested by | Sachin Tripathi (platform owner), 2026-11-19: "is content agent going to create video using AI avatars and other video editing tools to make it more attractive for customers?" |
| Prepared by | Claude Code |
| Changes | Master PRD v3 (`docs/prd/2026-10-03-ai-marketing-agency-prd.md`) → v4 when approved |
| Phase | 3 (content and publishing). Nothing in phases 1 and 2 changes. |

## 1. Why

The PRD already has a Videographer / Video Editor agent (agent 9: reels, shorts and ads from uploaded footage, AI video to fill gaps) and an Animator (agent 10). It has no AI presenter: a generated person who speaks to camera. Presenter videos suit explainers, offers, FAQs and multilingual versions of the same message, and need no filming. They also carry risks the PRD does not yet cover: a real person's likeness, disclosure rules on each platform, per-minute tool cost, and a low-quality result hurting the brand.

## 2. Proposed changes to the PRD

### 2.1 Agent 9 (section 7.3), new responsibility text

> **Videographer / Video Editor** — Edits uploaded footage into reels, shorts and ads; AI video to fill gaps; **AI presenter (avatar) videos from an approved script, using an approved presenter**. Output: finished videos. Approval: per item; **each presenter is approved once (2.3)**.

### 2.2 New P1 requirement (section 11.2)

| ID | Requirement | Acceptance |
|---|---|---|
| **P1-8** | AI presenter videos | For a brand with an approved presenter, the video agent turns an approved script into a presenter video in the brand's style, in 9:16, 1:1 and 16:9, with captions and the platform's AI label. The video reaches the approval inbox with its script, presenter and cost. Nothing is published without approval. |

### 2.3 Presenters

1. **Stock presenter.** A generated person from the tool's library, with commercial rights for this use. Approved once per brand by the approver.
2. **Cloned presenter (a real person's face or voice).** Only with that person's **written, recorded consent** naming the brand, the uses and the duration. Consent can be withdrawn at any time: from then on no new video uses the likeness, and unpublished drafts are deleted. The consent record is stored with the brand and checked before every render. No public figures, no customers, no minors.
3. A presenter never makes a claim in their own name ("I used this coating…") unless the real person actually did and agreed to say it.

### 2.4 New AI-governance requirement (section 15)

| ID | Requirement | Rule |
|---|---|---|
| **AI-21** | Synthetic people | Every video with an AI presenter or cloned voice carries the platform's AI-content label and a visible "AI presenter" note where the platform has no label. The Legal agent blocks any presenter video without a valid presenter approval, and any cloned likeness without a current consent record. Scripts follow the verified-facts rule like any other copy. |

### 2.5 Cost and quality

- Avatar and voice tools charge per minute of video. Each render is recorded in the cost ledger and counts against the per-run, per-deliverable and per-brand limits (AI-14). A render that would pass a limit is not started.
- The Creative Director agent scores presenter videos on the existing scoring guide (AI-19), adding lip-sync and naturalness. A video below the brand's threshold never reaches the approver.

## 3. Decisions left to the phase 3 spec

- **Tools.** The avatar service (for example HeyGen or Synthesia), the voice service (for example ElevenLabs) and the video-editing pipeline are chosen in the phase 3 spec after a side-by-side trial on real Aztek scripts, judged by the owner. The chosen tools sit behind the existing provider module, so a tool can be swapped without changing the agents.
- **Languages.** English first (the owner's chosen language); others only when the owner adds them.
- **Where consent records are kept.** In the product database with the brand, under the same row-level security as other brand data.

## 4. What does not change

- Raw footage stays first: real installs, before-and-after shots and customer cars, edited by agent 9, remain the main video source. Presenter videos are an addition, not a replacement.
- Every video still needs approval before it goes live (section 9).
- The product still does not shoot photos or video (section 4).

## 5. For approval

Reply **"approved"** to accept sections 2.1 to 2.5 as written; the PRD then moves to v4 with these changes and the change is recorded in its document-control table. Or tell me what to change.
